// Idempotent dev-environment bootstrap for the local user.
//
// On a fresh DB this creates everything atomically:
//   - Persistent local identity (key file, gitignored, mode 0600)
//   - users row with the public keys
//   - chain_owners row for the user's user-primary chain
//   - user-primary-genesis event on the user's chain
//   - chain_owners rows for the platform-owned chains
//
// On a DB that's already been bootstrapped, every step detects existing
// state and skips. Order of invocation (fresh, partial, full) does not
// change the resulting state.

import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { ensureLocalIdentity } from '../src/identity/local-key-store.js';
import { ensureUserPrimaryChain } from '../src/identity/register-user.js';
import { users, chainOwners } from '../src/db/schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://epagoge:epagoge_dev@localhost:5432/epagoge';

const LOCAL_USER_SOURCE_ID = 'local_user';
const PLATFORM_OWNED_CHAINS = ['reasoning-capture', 'system-operational'];

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const { identity, created, path } = await ensureLocalIdentity(LOCAL_USER_SOURCE_ID);
console.log(
  created
    ? `Generated new local identity at ${path}.`
    : `Reusing existing local identity from ${path}.`,
);

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const db = drizzle(pool);

try {
  // Reconcile public keys on an existing user row if they drifted.
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.sourceId, LOCAL_USER_SOURCE_ID))
    .limit(1);
  if (existing.length > 0) {
    const row = existing[0]!;
    const dbPq = new Uint8Array(row.attestationPublicKeyPq);
    const dbClassical = new Uint8Array(row.attestationPublicKeyClassical);
    const pubKeyMismatch =
      !bytesEqual(dbPq, identity.mldsa.publicKey) ||
      !bytesEqual(dbClassical, identity.ed25519.publicKey);
    if (pubKeyMismatch) {
      await db
        .update(users)
        .set({
          attestationPublicKeyPq: identity.mldsa.publicKey,
          attestationPublicKeyClassical: identity.ed25519.publicKey,
        })
        .where(eq(users.id, row.id));
      console.log(`local_user public keys reconciled with identity file (id=${row.id}).`);
    }
  }

  // ensureUserPrimaryChain: insert user (if missing), claim chain (if missing),
  // append genesis (if missing). Idempotent across partial states.
  const result = await ensureUserPrimaryChain({
    pool,
    identity,
    displayName: 'Local Developer',
  });
  if (result.alreadyRegistered) {
    console.log(
      `local_user already fully bootstrapped (id=${result.userId}, chain=${result.chainId}).`,
    );
  } else {
    console.log(`local_user bootstrapped (id=${result.userId}).`);
    console.log(`  chain: ${result.chainId}`);
    console.log(`  genesis event: ${result.genesisEventHash}`);
  }

  // Platform-owned chains: claim if not already in chain_owners.
  for (const chainId of PLATFORM_OWNED_CHAINS) {
    const owner = await db
      .select()
      .from(chainOwners)
      .where(eq(chainOwners.chainId, chainId))
      .limit(1);
    if (owner.length === 0) {
      await db.insert(chainOwners).values({
        chainId,
        ownerType: 'platform',
        ownerEntityId: 'platform',
      });
      console.log(`chain_owners: claimed ${chainId} for platform.`);
    }
  }
} finally {
  await pool.end();
}
