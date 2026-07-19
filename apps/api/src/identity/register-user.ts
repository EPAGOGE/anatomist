// Transactional user registration.
//
// Single transaction across:
//   1. Insert users row with public keys
//   2. Insert chain_owners row claiming the user-primary chain
//   3. Sign and append the user-primary-genesis event to the new chain
// Any failure rolls all three back.
//
// The local identity (secret + public keys) is persisted to disk by
// ensureLocalIdentity BEFORE this function runs; the secret keys never enter
// the database. The database stores only the public halves.

import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { blake3 } from '@epagoge/crypto';
import {
  encodeCanonicalCbor,
  UserPrimaryGenesisSchema,
  type UserPrimaryGenesisPayload,
  type NodeRole,
} from '@epagoge/shared';
import {
  createPostgresLedger,
  signEvent,
  userPrimaryChainId,
  type PublicKeyResolver,
} from '@epagoge/ledger';
import { users, chainOwners } from '../db/schema.js';
import type { LocalIdentity } from './local-key-store.js';

export interface RegisterUserResult {
  userId: string;
  sourceId: string;
  chainId: string;
  genesisEventHash: string;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface RegisterUserOptions {
  pool: pg.Pool;
  identity: LocalIdentity;
  displayName: string;
  role?: NodeRole;
}

/**
 * Idempotency contract: caller MUST check whether a user with the given
 * source_id already exists before calling this. registerUser does not
 * dedupe — calling it twice for the same source_id will fail the unique
 * constraint on users.source_id with a Postgres error.
 */
export async function registerUser(options: RegisterUserOptions): Promise<RegisterUserResult> {
  const { pool, identity, displayName, role = 'node' } = options;
  const ledger = createPostgresLedger({ pool });

  try {
    return await ledger.withinTransaction(async (txLedger, tx) => {
      // 1. Insert the users row. defaultRandom() generates the UUID, which
      //    becomes the user_id used in chain_id and chain_owners.
      const [inserted] = await tx
        .insert(users)
        .values({
          sourceId: identity.sourceId,
          displayName,
          role,
          attestationPublicKeyPq: identity.mldsa.publicKey,
          attestationPublicKeyClassical: identity.ed25519.publicKey,
        })
        .returning();
      if (!inserted) throw new Error('users insert returned no row');

      const chainId = userPrimaryChainId(inserted.id);

      // 2. Claim the chain in chain_owners.
      await tx.insert(chainOwners).values({
        chainId,
        ownerType: 'user',
        ownerEntityId: inserted.id,
      });

      // 3. Build, sign, and append the genesis event.
      const fingerprintPq = bytesToHex(blake3.hash(identity.mldsa.publicKey));
      const fingerprintClassical = bytesToHex(blake3.hash(identity.ed25519.publicKey));
      const payload: UserPrimaryGenesisPayload = {
        kind: 'user-primary-genesis',
        details: {
          user_id: inserted.id,
          source_id: identity.sourceId,
          display_name: displayName,
          created_at: new Date().toISOString(),
          public_key_fingerprints: {
            pq_blake3: fingerprintPq,
            classical_blake3: fingerprintClassical,
          },
        },
      };
      UserPrimaryGenesisSchema.parse(payload);

      const payloadBytes = encodeCanonicalCbor(payload);
      const payloadIntegrity = bytesToHex(blake3.hash(payloadBytes));

      // Resolver scoped to this registration — uses the in-memory identity
      // because the users row is not yet visible outside this transaction.
      const txResolver: PublicKeyResolver = async (sid) =>
        sid === identity.sourceId
          ? { pq: identity.mldsa.publicKey, classical: identity.ed25519.publicKey }
          : null;

      const event = await signEvent(
        {
          version: 1,
          chain_id: chainId,
          event_type: 'system-operational',
          source_id: identity.sourceId,
          causal_predecessors: [],
          absence_set_delta: [],
          source_reliability: 65535,
          causal_sequence_marker: 1n,
          ground_truth_calibration_indicator: undefined,
          payload_integrity: payloadIntegrity,
        },
        { pq: identity.mldsa, classical: identity.ed25519 },
      );

      const genesisEventHash = await txLedger.appendEvent(event, txResolver, {
        payload: payloadBytes,
      });

      return {
        userId: inserted.id,
        sourceId: identity.sourceId,
        chainId,
        genesisEventHash,
      };
    });
  } finally {
    await ledger.close();
  }
}

/**
 * Idempotent: returns the existing user's primary chain info when the user
 * already has one, registers fresh otherwise.
 */
export async function ensureUserPrimaryChain(
  options: RegisterUserOptions,
): Promise<RegisterUserResult & { alreadyRegistered: boolean }> {
  const { pool, identity, displayName } = options;
  const db = drizzle(pool);
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.sourceId, identity.sourceId))
    .limit(1);
  const row = existing[0];
  if (row) {
    const chainId = userPrimaryChainId(row.id);
    // chain_owners row may be missing if the user was created before this
    // commit; backfill it idempotently.
    const ownerRows = await db
      .select()
      .from(chainOwners)
      .where(eq(chainOwners.chainId, chainId))
      .limit(1);
    if (ownerRows.length === 0) {
      await db.insert(chainOwners).values({
        chainId,
        ownerType: 'user',
        ownerEntityId: row.id,
      });
    }
    // The genesis event may also be missing. Append it if so.
    const ledger = createPostgresLedger({ pool });
    try {
      const head = await ledger.getChainHead(chainId, identity.sourceId);
      if (head) {
        return {
          userId: row.id,
          sourceId: identity.sourceId,
          chainId,
          genesisEventHash: head.headHash,
          alreadyRegistered: true,
        };
      }
    } finally {
      await ledger.close();
    }
    // Genesis missing — append it (NOT inside the same tx as the existing
    // user row; the user row already exists).
    const genesis = await appendGenesisForExistingUser({
      pool,
      identity,
      userId: row.id,
      chainId,
      displayName,
    });
    return {
      userId: row.id,
      sourceId: identity.sourceId,
      chainId,
      genesisEventHash: genesis,
      alreadyRegistered: false,
    };
  }
  const result = await registerUser(options);
  return { ...result, alreadyRegistered: false };
}

async function appendGenesisForExistingUser(params: {
  pool: pg.Pool;
  identity: LocalIdentity;
  userId: string;
  chainId: string;
  displayName: string;
}): Promise<string> {
  const ledger = createPostgresLedger({ pool: params.pool });
  try {
    const fingerprintPq = bytesToHex(blake3.hash(params.identity.mldsa.publicKey));
    const fingerprintClassical = bytesToHex(blake3.hash(params.identity.ed25519.publicKey));
    const payload: UserPrimaryGenesisPayload = {
      kind: 'user-primary-genesis',
      details: {
        user_id: params.userId,
        source_id: params.identity.sourceId,
        display_name: params.displayName,
        created_at: new Date().toISOString(),
        public_key_fingerprints: {
          pq_blake3: fingerprintPq,
          classical_blake3: fingerprintClassical,
        },
      },
    };
    UserPrimaryGenesisSchema.parse(payload);
    const payloadBytes = encodeCanonicalCbor(payload);
    const payloadIntegrity = bytesToHex(blake3.hash(payloadBytes));

    const resolver: PublicKeyResolver = async (sid) =>
      sid === params.identity.sourceId
        ? {
            pq: params.identity.mldsa.publicKey,
            classical: params.identity.ed25519.publicKey,
          }
        : null;

    const event = await signEvent(
      {
        version: 1,
        chain_id: params.chainId,
        event_type: 'system-operational',
        source_id: params.identity.sourceId,
        causal_predecessors: [],
        absence_set_delta: [],
        source_reliability: 65535,
        causal_sequence_marker: 1n,
        ground_truth_calibration_indicator: undefined,
        payload_integrity: payloadIntegrity,
      },
      { pq: params.identity.mldsa, classical: params.identity.ed25519 },
    );

    return ledger.appendEvent(event, resolver, { payload: payloadBytes });
  } finally {
    await ledger.close();
  }
}
