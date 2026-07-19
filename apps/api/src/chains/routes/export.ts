// GET /export/me
//
// Verifiable cryptographic export. Returns a JSON bundle containing every
// signed event on every chain the authenticated user can read, with the
// public-key fingerprints needed to verify the signatures offline.
//
// Bundle format (v1) — designed to be portable and self-verifying:
//
//   {
//     bundle_version: 1,
//     generated_at: ISO8601,
//     subject: { user_id, source_id, display_name, ... },
//     keys: {
//       <source_id>: { pq_blake3: hex, classical_blake3: hex,
//                      pq_public_key_b64: base64, classical_public_key_b64: base64 }
//     },
//     chains: [
//       {
//         chain_id, owner_type, owner_entity_id,
//         head_hash, head_sequence_marker, event_count,
//         events: [
//           {
//             event_hash, version, chain_id, event_type, source_id,
//             causal_sequence_marker, causal_predecessors, source_reliability,
//             payload_integrity, ground_truth_calibration_indicator?,
//             signature_pq_b64, signature_classical_b64,
//             payload_b64?
//           }, ...
//         ]
//       }, ...
//     ],
//     verification_instructions: <prose describing how to verify offline>
//   }
//
// The recipient runs the verification recipe (recompute event_hash from
// canonical CBOR encoding, verify both signatures against the included
// public keys) and gets cryptographic confirmation that every event in
// the bundle was signed by the keys claimed.
//
// Unique to platforms with on-chain reasoning capture. Most platforms
// can produce "your data" exports; few can produce "your data, signed,
// verifiable independently of us, without trusting us."

import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { desc, eq } from 'drizzle-orm';
import { createPostgresLedger, type LedgerHandle } from '@epagoge/ledger';
import { blake3 } from '@epagoge/crypto';
import { chainHeads, users } from '../../db/schema.js';
import type { JwtKey } from '../../auth/jwt.js';
import { listReadableChains } from '../permissions.js';
import { resolveAuth } from '../../auth/local-user.js';

export interface ExportPluginOptions {
  jwtKey: JwtKey;
}

const VERIFICATION_INSTRUCTIONS = `
To verify this bundle offline:

1. Pick any source_id that appears in 'keys'. The 'keys' map gives you
   the public-key fingerprints (BLAKE3 of the public key bytes) plus the
   raw public keys themselves (base64).

2. For each event whose source_id matches the picked source_id:
   a. Reconstruct the AttestedEvent JS object from the event fields.
   b. Encode it as canonical CBOR (RFC 8949) per the EPAGOGE schema —
      sorted keys, signature_pq + signature_classical decoded from base64.
   c. Recompute BLAKE3 of the canonical bytes; assert it matches the
      'event_hash' field.
   d. Build the signing-payload (the event without 'attestation_signature')
      and encode it as canonical CBOR.
   e. Verify the ML-DSA-65 signature against the pq public key.
   f. Verify the Ed25519 signature against the classical public key.

3. Both signatures verify ⇒ this event was signed by the holder of the
   private keys corresponding to the included public-key fingerprints
   at the time of signing. Combined with the chain's append-only
   predecessor-by-hash structure, this gives you cryptographic proof of
   the event's content AND its causal position.

The EPAGOGE wire format (canonical CBOR rules, signature primitives, hash
function) is documented in the platform's open ADRs 0003, 0005, 0007.
A reference verifier in TypeScript is in packages/ledger (re-implementable
in any language with CBOR + Ed25519 + ML-DSA-65 libraries).
`.trim();

export const exportPlugin: FastifyPluginAsync<ExportPluginOptions> = async (app, opts) => {
  app.get('/export/me', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }

    const auth = resolveAuth(request, reply, opts.jwtKey);
    if (!auth) return;

    const db = drizzle(app.pool);

    // Subject (the user themselves).
    const userRow = (await db.select().from(users).where(eq(users.id, auth.userId)).limit(1))[0];
    if (!userRow) {
      return reply
        .code(404)
        .send({ error: { code: 'user-not-found', message: 'subject user no longer exists' } });
    }

    const subject = {
      user_id: userRow.id,
      source_id: userRow.sourceId,
      display_name: userRow.displayName,
      email_lower: userRow.emailLower,
      created_at: userRow.createdAt.toISOString(),
    };

    // Collect public keys per source_id. We need every source that signed
    // events on any chain the user can read. Phase 0: collect from the
    // users table (any user with public keys).
    const allUsers = await db.select().from(users);
    const keys: Record<
      string,
      {
        pq_blake3: string;
        classical_blake3: string;
        pq_public_key_b64: string;
        classical_public_key_b64: string;
      }
    > = {};
    for (const u of allUsers) {
      keys[u.sourceId] = {
        pq_blake3: hashPublicKey(u.attestationPublicKeyPq),
        classical_blake3: hashPublicKey(u.attestationPublicKeyClassical),
        pq_public_key_b64: Buffer.from(u.attestationPublicKeyPq).toString('base64'),
        classical_public_key_b64: Buffer.from(u.attestationPublicKeyClassical).toString('base64'),
      };
    }

    // Walk readable chains.
    const chains = await listReadableChains(app.pool, auth.userId);
    const ledger = createPostgresLedger({ pool: app.pool });
    try {
      const chainBundles = [];
      for (const chain of chains) {
        const bundle = await buildChainBundle(app.pool, ledger, chain.chainId);
        chainBundles.push({
          chain_id: chain.chainId,
          owner_type: chain.ownerType,
          owner_entity_id: chain.ownerEntityId,
          ...bundle,
        });
      }

      return reply.send({
        bundle_version: 1,
        generated_at: new Date().toISOString(),
        subject,
        keys,
        chains: chainBundles,
        verification_instructions: VERIFICATION_INSTRUCTIONS,
      });
    } finally {
      await ledger.close();
    }
  });
};

async function buildChainBundle(
  pool: pg.Pool,
  ledger: LedgerHandle,
  chainId: string,
): Promise<{
  head_hash: string | null;
  head_sequence_marker: string | null;
  event_count: number;
  events: Array<Record<string, unknown>>;
}> {
  // Find primary head (across all source_ids — see chains/routes/explorer.ts
  // for the same pattern).
  const db = drizzle(pool);
  const head = (
    await db
      .select()
      .from(chainHeads)
      .where(eq(chainHeads.chainId, chainId))
      .orderBy(desc(chainHeads.headSequenceMarker))
      .limit(1)
  )[0];
  if (!head) {
    return { head_hash: null, head_sequence_marker: null, event_count: 0, events: [] };
  }

  // Walk head → genesis along the linear backbone. For chains with
  // multiple writers this only catches the primary writer's view;
  // multi-source export is a future enhancement.
  const events = [];
  let cursor: string | null = head.headHash;
  while (cursor) {
    const event = await ledger.getEvent(cursor);
    if (!event) break;
    const payload = await ledger.getEventPayload(cursor);
    events.push({
      event_hash: cursor,
      version: event.version,
      chain_id: event.chain_id,
      event_type: event.event_type,
      source_id: event.source_id,
      causal_sequence_marker: event.causal_sequence_marker.toString(),
      causal_predecessors: event.causal_predecessors,
      absence_set_delta: event.absence_set_delta.map((a) => ({
        expected_hash: a.expected_hash,
        window_start: a.window_start.toString(),
        window_end: a.window_end.toString(),
      })),
      source_reliability: event.source_reliability,
      payload_integrity: event.payload_integrity,
      ...(event.ground_truth_calibration_indicator !== undefined
        ? { ground_truth_calibration_indicator: event.ground_truth_calibration_indicator }
        : {}),
      signature_pq_b64: Buffer.from(event.attestation_signature.pq).toString('base64'),
      signature_classical_b64: Buffer.from(event.attestation_signature.classical).toString(
        'base64',
      ),
      ...(payload ? { payload_b64: Buffer.from(payload).toString('base64') } : {}),
    });
    cursor = event.causal_predecessors.length > 0 ? event.causal_predecessors[0]! : null;
  }

  return {
    head_hash: head.headHash,
    head_sequence_marker: head.headSequenceMarker.toString(),
    event_count: events.length,
    events,
  };
}

function hashPublicKey(bytes: Uint8Array): string {
  return Array.from(blake3.hash(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
