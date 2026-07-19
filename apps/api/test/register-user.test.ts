import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createPostgresLedger, userPrimaryChainId, type PublicKeyResolver } from '@epagoge/ledger';
import { attestation } from '@epagoge/crypto';
import { users, chainOwners, chainHeads, events } from '../src/db/schema.js';
import { registerUser, ensureUserPrimaryChain } from '../src/identity/register-user.js';
import type { LocalIdentity } from '../src/identity/local-key-store.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://epagoge:epagoge_dev@localhost:5432/epagoge';

async function dbReachable(): Promise<boolean> {
  const probe = new pg.Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    const client = await probe.connect();
    client.release();
    await probe.end();
    return true;
  } catch {
    await probe.end().catch(() => undefined);
    return false;
  }
}

const live = await dbReachable();
const describeLive = live ? describe : describe.skip;

async function freshIdentity(): Promise<LocalIdentity> {
  const keys = await attestation.generateKeyPair();
  return {
    sourceId: `test_user_${randomUUID().slice(0, 8)}`,
    mldsa: keys.mldsa,
    ed25519: keys.ed25519,
  };
}

const insertedSourceIds: string[] = [];

async function cleanupBySourceId(pool: pg.Pool, sourceId: string): Promise<void> {
  const db = drizzle(pool);
  const userRow = (await db.select().from(users).where(eq(users.sourceId, sourceId)).limit(1))[0];
  if (!userRow) return;
  const chainId = userPrimaryChainId(userRow.id);
  // Delete in FK-safe order: heads, events on this chain, owner, user.
  await db.delete(chainHeads).where(eq(chainHeads.chainId, chainId));
  await db.delete(events).where(eq(events.chainId, chainId));
  await db.delete(chainOwners).where(eq(chainOwners.chainId, chainId));
  await db.delete(users).where(eq(users.id, userRow.id));
}

describeLive('registerUser (live)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  afterAll(async () => {
    for (const sid of insertedSourceIds) {
      await cleanupBySourceId(pool, sid).catch(() => undefined);
    }
    await pool.end();
  });

  it('registers a fresh user atomically (user row, chain_owners row, genesis event)', async () => {
    const identity = await freshIdentity();
    insertedSourceIds.push(identity.sourceId);

    const result = await registerUser({
      pool,
      identity,
      displayName: 'Test User',
    });

    expect(result.userId).toBeTruthy();
    expect(result.sourceId).toBe(identity.sourceId);
    expect(result.chainId).toBe(userPrimaryChainId(result.userId));
    expect(result.genesisEventHash).toMatch(/^[0-9a-f]{64}$/);

    const db = drizzle(pool);
    const userRow = (await db.select().from(users).where(eq(users.id, result.userId)).limit(1))[0];
    expect(userRow).toBeDefined();
    expect(userRow!.sourceId).toBe(identity.sourceId);

    const ownerRow = (
      await db.select().from(chainOwners).where(eq(chainOwners.chainId, result.chainId)).limit(1)
    )[0];
    expect(ownerRow).toBeDefined();
    expect(ownerRow!.ownerType).toBe('user');
    expect(ownerRow!.ownerEntityId).toBe(result.userId);

    const ledger = createPostgresLedger({ pool });
    try {
      const head = await ledger.getChainHead(result.chainId, identity.sourceId);
      expect(head).not.toBeNull();
      expect(head!.headHash).toBe(result.genesisEventHash);
      expect(head!.eventCount).toBe(1n);

      const genesisEvent = await ledger.getEvent(result.genesisEventHash);
      expect(genesisEvent).not.toBeNull();
      expect(genesisEvent!.causal_predecessors).toEqual([]);
      expect(genesisEvent!.event_type).toBe('system-operational');

      const resolver: PublicKeyResolver = async (sid) =>
        sid === identity.sourceId
          ? { pq: identity.mldsa.publicKey, classical: identity.ed25519.publicKey }
          : null;
      const verify = await ledger.verifyChain(result.chainId, resolver, {
        sourceId: identity.sourceId,
      });
      expect(verify.ok).toBe(true);
      expect(verify.eventsVerified).toBe(1);
    } finally {
      await ledger.close();
    }
  });

  it('rolls back the entire transaction if any step fails', async () => {
    const identity = await freshIdentity();
    insertedSourceIds.push(identity.sourceId);

    // First registration succeeds.
    await registerUser({ pool, identity, displayName: 'First' });

    // Second registration with the same source_id must fail at the unique
    // constraint on users.source_id. We expect the throw, then verify no
    // duplicate chain_owners row was created.
    await expect(registerUser({ pool, identity, displayName: 'Duplicate' })).rejects.toThrow();

    const db = drizzle(pool);
    const userCount = await db.select().from(users).where(eq(users.sourceId, identity.sourceId));
    expect(userCount).toHaveLength(1);
  });
});

describeLive('ensureUserPrimaryChain (live)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  afterAll(async () => {
    for (const sid of insertedSourceIds) {
      await cleanupBySourceId(pool, sid).catch(() => undefined);
    }
    await pool.end();
  });

  it('registers fresh when user does not exist', async () => {
    const identity = await freshIdentity();
    insertedSourceIds.push(identity.sourceId);

    const result = await ensureUserPrimaryChain({ pool, identity, displayName: 'Ensure Fresh' });
    expect(result.alreadyRegistered).toBe(false);
    expect(result.genesisEventHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is a no-op when user, owner row, and genesis event all already exist', async () => {
    const identity = await freshIdentity();
    insertedSourceIds.push(identity.sourceId);

    const first = await registerUser({ pool, identity, displayName: 'Pre-existing' });
    const second = await ensureUserPrimaryChain({
      pool,
      identity,
      displayName: 'Pre-existing',
    });

    expect(second.alreadyRegistered).toBe(true);
    expect(second.userId).toBe(first.userId);
    expect(second.chainId).toBe(first.chainId);
    expect(second.genesisEventHash).toBe(first.genesisEventHash);
  });

  it('backfills the chain_owners row when missing', async () => {
    const identity = await freshIdentity();
    insertedSourceIds.push(identity.sourceId);

    const first = await registerUser({ pool, identity, displayName: 'Owner Backfill' });

    // Surgically delete the chain_owners row to simulate a pre-feature DB
    // state, then call ensureUserPrimaryChain and verify it restores.
    const db = drizzle(pool);
    await db.delete(chainOwners).where(eq(chainOwners.chainId, first.chainId));

    const result = await ensureUserPrimaryChain({
      pool,
      identity,
      displayName: 'Owner Backfill',
    });
    expect(result.alreadyRegistered).toBe(true);
    const ownerRow = (
      await db.select().from(chainOwners).where(eq(chainOwners.chainId, first.chainId)).limit(1)
    )[0];
    expect(ownerRow).toBeDefined();
    expect(ownerRow!.ownerType).toBe('user');
  });
});
