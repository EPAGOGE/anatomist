// Transactional HTTP user registration.
//
// Single Postgres transaction across:
//   1. Generate a fresh hybrid keypair (ML-DSA-65 + Ed25519)
//   2. Hash the password (argon2id)
//   3. Insert the users row with email, password_hash, public keys, and
//      envelope-encrypted secret keys
//   4. Insert the chain_owners row claiming user-primary:${user_uuid}
//   5. Sign + append the user-primary-genesis event to that chain
//
// All five succeed or all five roll back. The freshly-generated secret
// key bytes are zeroed in this function's scope as soon as the
// genesis event is signed; only the envelope-encrypted copies persist.
//
// Auth-events chain emission (auth-registration) happens AFTER this
// function returns, because the auth-events chain append is in a
// separate transaction (it doesn't need to be atomic with user creation
// — a user with no auth-registration event is still a valid user; the
// auth-events chain is observability, not source of truth).

import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { blake3, attestation } from '@epagoge/crypto';
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
import { encryptEnvelope, type MasterKey } from './master-key.js';
import { hashPassword } from './password.js';

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface RegisterHttpUserOptions {
  pool: pg.Pool;
  master: MasterKey;
  email: string;
  password: string;
  displayName: string;
  /** Per ADR-0009 ('source_id'-as-presence-marker), we derive sourceId from a UUID. */
  sourceId: string;
  role?: NodeRole;
}

export interface RegisterHttpUserResult {
  userId: string;
  sourceId: string;
  chainId: string;
  genesisEventHash: string;
  emailLower: string;
  publicKeyFingerprintPq: string;
  publicKeyFingerprintClassical: string;
}

export async function registerHttpUser(
  options: RegisterHttpUserOptions,
): Promise<RegisterHttpUserResult> {
  const { pool, master, email, password, displayName, role = 'node' } = options;
  if (!email || !password) throw new Error('email and password are required');
  if (password.length < 12) {
    throw new Error('password must be at least 12 characters');
  }

  const emailLower = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);

  // Generate the user's hybrid keypair. The secret bytes live in this
  // function's scope only for as long as it takes to sign the genesis
  // event; the encrypted envelope is what reaches the DB.
  const keys = await attestation.generateKeyPair();
  const secretPqEnvelope = encryptEnvelope(keys.mldsa.secretKey, master);
  const secretClassicalEnvelope = encryptEnvelope(keys.ed25519.secretKey, master);

  const ledger = createPostgresLedger({ pool });
  try {
    return await ledger.withinTransaction(async (txLedger, tx) => {
      const [inserted] = await tx
        .insert(users)
        .values({
          sourceId: options.sourceId,
          displayName,
          role,
          attestationPublicKeyPq: keys.mldsa.publicKey,
          attestationPublicKeyClassical: keys.ed25519.publicKey,
          email: email.trim(),
          emailLower,
          passwordHash,
          attestationSecretKeyPqEnvelope: secretPqEnvelope,
          attestationSecretKeyClassicalEnvelope: secretClassicalEnvelope,
        })
        .returning();
      if (!inserted) throw new Error('users insert returned no row');

      const chainId = userPrimaryChainId(inserted.id);

      await tx.insert(chainOwners).values({
        chainId,
        ownerType: 'user',
        ownerEntityId: inserted.id,
      });

      const fingerprintPq = bytesToHex(blake3.hash(keys.mldsa.publicKey));
      const fingerprintClassical = bytesToHex(blake3.hash(keys.ed25519.publicKey));

      const payload: UserPrimaryGenesisPayload = {
        kind: 'user-primary-genesis',
        details: {
          user_id: inserted.id,
          source_id: options.sourceId,
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

      const txResolver: PublicKeyResolver = async (sid) =>
        sid === options.sourceId
          ? { pq: keys.mldsa.publicKey, classical: keys.ed25519.publicKey }
          : null;

      const event = await signEvent(
        {
          version: 1,
          chain_id: chainId,
          event_type: 'system-operational',
          source_id: options.sourceId,
          causal_predecessors: [],
          absence_set_delta: [],
          source_reliability: 65535,
          causal_sequence_marker: 1n,
          ground_truth_calibration_indicator: undefined,
          payload_integrity: payloadIntegrity,
        },
        { pq: keys.mldsa, classical: keys.ed25519 },
      );

      const genesisEventHash = await txLedger.appendEvent(event, txResolver, {
        payload: payloadBytes,
      });

      // Best-effort zero of the secret bytes now that we no longer need
      // them. JS doesn't guarantee the underlying buffers stay zeroed
      // (GC may have copied), but this defends against accidental reuse.
      keys.mldsa.secretKey.fill(0);
      keys.ed25519.secretKey.fill(0);

      return {
        userId: inserted.id,
        sourceId: options.sourceId,
        chainId,
        genesisEventHash,
        emailLower,
        publicKeyFingerprintPq: fingerprintPq,
        publicKeyFingerprintClassical: fingerprintClassical,
      };
    });
  } finally {
    await ledger.close();
  }
}

export async function findUserByEmailLower(pool: pg.Pool, emailLower: string) {
  const db = drizzle(pool);
  const rows = await db.select().from(users).where(eq(users.emailLower, emailLower)).limit(1);
  return rows[0] ?? null;
}
