import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { attestation } from '@epagoge/crypto';
import type { AttestedEvent } from '@epagoge/shared';
import { computeEventHash, signEvent } from '../src/canonical.js';
import { createPostgresLedger } from '../src/postgres.js';
import { AppendError, type PublicKeyResolver } from '../src/types.js';

const DATABASE_URL =
  process.env.EPAGOGE_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://epagoge:epagoge_dev@localhost:5432/epagoge';

async function databaseReachable(): Promise<boolean> {
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

const integration = await databaseReachable();
const describeIntegration = integration ? describe : describe.skip;

if (!integration) {
  console.warn(
    `[ledger/postgres] DB at ${DATABASE_URL} unreachable — skipping integration tests. Bring up docker-compose for full coverage.`,
  );
}

describeIntegration('PostgresLedger — integration', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const ledger = createPostgresLedger({ pool });

  beforeAll(async () => {
    // Apply schema for the ledger tables. Idempotent.
    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE "event_type" AS ENUM('user-generated', 'synthetic-derived', 'system-operational', 'validation-attestation');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS events (
        event_hash varchar(64) PRIMARY KEY,
        chain_id varchar(64) NOT NULL,
        event_type event_type NOT NULL,
        source_id varchar(255) NOT NULL,
        causal_sequence_marker bigint NOT NULL,
        source_reliability smallint NOT NULL,
        payload_integrity varchar(64) NOT NULL,
        signature_pq bytea NOT NULL,
        signature_classical bytea NOT NULL,
        ground_truth_calibration_indicator text,
        created_at timestamp with time zone DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_predecessors (
        event_hash varchar(64) NOT NULL REFERENCES events(event_hash) ON DELETE CASCADE,
        ordinal integer NOT NULL,
        predecessor_hash varchar(64) NOT NULL,
        PRIMARY KEY (event_hash, ordinal)
      );

      CREATE TABLE IF NOT EXISTS event_absence_entries (
        event_hash varchar(64) NOT NULL REFERENCES events(event_hash) ON DELETE CASCADE,
        ordinal integer NOT NULL,
        expected_hash varchar(64) NOT NULL,
        window_start bigint NOT NULL,
        window_end bigint NOT NULL,
        PRIMARY KEY (event_hash, ordinal)
      );

      CREATE TABLE IF NOT EXISTS chain_heads (
        chain_id varchar(64) NOT NULL,
        source_id varchar(255) NOT NULL,
        head_hash varchar(64) NOT NULL,
        head_sequence_marker bigint NOT NULL,
        event_count bigint NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL,
        PRIMARY KEY (chain_id, source_id)
      );
    `);

    // Clean only test-prefixed chains so we don't clobber app-seeded data
    // (user-primary, reasoning-capture, system-operational) that other test
    // suites and the doctor depend on.
    await pool.query(`DELETE FROM event_absence_entries WHERE event_hash IN (
      SELECT event_hash FROM events WHERE chain_id LIKE 'test-%'
    );`);
    await pool.query(`DELETE FROM event_predecessors WHERE event_hash IN (
      SELECT event_hash FROM events WHERE chain_id LIKE 'test-%'
    );`);
    await pool.query(`DELETE FROM events WHERE chain_id LIKE 'test-%';`);
    await pool.query(`DELETE FROM chain_heads WHERE chain_id LIKE 'test-%';`);
  });

  afterAll(async () => {
    await ledger.close();
  });

  it('appendEvent → getEvent → walkPredecessors → verifyChain end-to-end', async () => {
    const keys = await attestation.generateKeyPair();
    const sourceId = `source-${Math.random().toString(36).slice(2, 8)}`;
    const chainId = 'test-reasoning';

    const validHash = (n: number) => n.toString(16).padStart(64, '0');

    const resolver: PublicKeyResolver = async (sid) =>
      sid === sourceId ? { pq: keys.mldsa.publicKey, classical: keys.ed25519.publicKey } : null;

    // Build a 3-event linear chain. Event[0] has no predecessors. Each
    // successor references the prior event by hash.
    const evt0 = await signEvent(
      {
        version: 1,
        chain_id: chainId,
        event_type: 'system-operational',
        source_id: sourceId,
        causal_predecessors: [],
        absence_set_delta: [],
        source_reliability: 60000,
        causal_sequence_marker: 1n,
        ground_truth_calibration_indicator: undefined,
        payload_integrity: validHash(1),
      },
      { pq: keys.mldsa, classical: keys.ed25519 },
    );

    const hash0 = await ledger.appendEvent(evt0, resolver);
    expect(hash0).toMatch(/^[0-9a-f]{64}$/);

    const evt1 = await signEvent(
      {
        version: 1,
        chain_id: chainId,
        event_type: 'system-operational',
        source_id: sourceId,
        causal_predecessors: [hash0],
        absence_set_delta: [],
        source_reliability: 60000,
        causal_sequence_marker: 2n,
        ground_truth_calibration_indicator: undefined,
        payload_integrity: validHash(2),
      },
      { pq: keys.mldsa, classical: keys.ed25519 },
    );
    const hash1 = await ledger.appendEvent(evt1, resolver);

    const evt2 = await signEvent(
      {
        version: 1,
        chain_id: chainId,
        event_type: 'system-operational',
        source_id: sourceId,
        causal_predecessors: [hash1],
        absence_set_delta: [],
        source_reliability: 60000,
        causal_sequence_marker: 3n,
        ground_truth_calibration_indicator: undefined,
        payload_integrity: validHash(3),
      },
      { pq: keys.mldsa, classical: keys.ed25519 },
    );
    const hash2 = await ledger.appendEvent(evt2, resolver);

    // getEvent
    const fetched = await ledger.getEvent(hash2);
    expect(fetched).not.toBeNull();
    expect(fetched?.causal_sequence_marker).toBe(3n);
    expect(fetched?.causal_predecessors).toEqual([hash1]);

    // walkPredecessors yields hash2, hash1, hash0 in that order
    const walked: string[] = [];
    for await (const e of ledger.walkPredecessors(hash2)) {
      walked.push(`${e.causal_sequence_marker}`);
    }
    expect(walked).toEqual(['3', '2', '1']);

    // chain head
    const head = await ledger.getChainHead(chainId, sourceId);
    expect(head?.headHash).toBe(hash2);
    expect(head?.headSequenceMarker).toBe(3n);
    expect(head?.eventCount).toBe(3n);

    // verifyChain
    const verification = await ledger.verifyChain(chainId, resolver, { sourceId });
    expect(verification.ok).toBe(true);
    expect(verification.eventsVerified).toBe(3);
    expect(verification.failures).toEqual([]);
  });

  it('appendEvent rejects when public key resolver returns null', async () => {
    const keys = await attestation.generateKeyPair();
    const sourceId = `missing-${Math.random().toString(36).slice(2, 8)}`;
    const evt = await signEvent(
      {
        version: 1,
        chain_id: 'test-reasoning',
        event_type: 'system-operational',
        source_id: sourceId,
        causal_predecessors: [],
        absence_set_delta: [],
        source_reliability: 1,
        causal_sequence_marker: 100n,
        ground_truth_calibration_indicator: undefined,
        payload_integrity: 'd'.repeat(64),
      },
      { pq: keys.mldsa, classical: keys.ed25519 },
    );
    await expect(ledger.appendEvent(evt, async () => null)).rejects.toBeInstanceOf(AppendError);
  });

  it('appendEvent rejects when predecessor is missing', async () => {
    const keys = await attestation.generateKeyPair();
    const sourceId = `pred-miss-${Math.random().toString(36).slice(2, 8)}`;
    const resolver: PublicKeyResolver = async () => ({
      pq: keys.mldsa.publicKey,
      classical: keys.ed25519.publicKey,
    });
    const evt = await signEvent(
      {
        version: 1,
        chain_id: 'test-reasoning',
        event_type: 'system-operational',
        source_id: sourceId,
        causal_predecessors: ['f'.repeat(64)],
        absence_set_delta: [],
        source_reliability: 1,
        causal_sequence_marker: 50n,
        ground_truth_calibration_indicator: undefined,
        payload_integrity: 'a'.repeat(64),
      },
      { pq: keys.mldsa, classical: keys.ed25519 },
    );
    const err: AppendError = await ledger.appendEvent(evt, resolver).catch((e) => e);
    expect(err).toBeInstanceOf(AppendError);
    expect(err.reason).toBe('predecessor-missing');
  });

  it('appendEvent rejects non-monotonic sequence marker', async () => {
    const keys = await attestation.generateKeyPair();
    const sourceId = `mono-${Math.random().toString(36).slice(2, 8)}`;
    const resolver: PublicKeyResolver = async () => ({
      pq: keys.mldsa.publicKey,
      classical: keys.ed25519.publicKey,
    });
    const validHash = (n: number) => n.toString(16).padStart(64, '0');

    const first = await signEvent(
      {
        version: 1,
        chain_id: 'test-reasoning',
        event_type: 'system-operational',
        source_id: sourceId,
        causal_predecessors: [],
        absence_set_delta: [],
        source_reliability: 1,
        causal_sequence_marker: 10n,
        ground_truth_calibration_indicator: undefined,
        payload_integrity: validHash(1),
      },
      { pq: keys.mldsa, classical: keys.ed25519 },
    );
    await ledger.appendEvent(first, resolver);

    const second = await signEvent(
      {
        version: 1,
        chain_id: 'test-reasoning',
        event_type: 'system-operational',
        source_id: sourceId,
        causal_predecessors: [],
        absence_set_delta: [],
        source_reliability: 1,
        causal_sequence_marker: 5n, // earlier than head — must reject
        ground_truth_calibration_indicator: undefined,
        payload_integrity: validHash(2),
      },
      { pq: keys.mldsa, classical: keys.ed25519 },
    );
    const err: AppendError = await ledger.appendEvent(second, resolver).catch((e) => e);
    expect(err).toBeInstanceOf(AppendError);
    expect(err.reason).toBe('sequence-marker-not-monotonic');
  });

  it('appendEvent rejects invalid signature post-tamper', async () => {
    const keys = await attestation.generateKeyPair();
    const sourceId = `sig-${Math.random().toString(36).slice(2, 8)}`;
    const resolver: PublicKeyResolver = async () => ({
      pq: keys.mldsa.publicKey,
      classical: keys.ed25519.publicKey,
    });
    const evt = await signEvent(
      {
        version: 1,
        chain_id: 'test-reasoning',
        event_type: 'system-operational',
        source_id: sourceId,
        causal_predecessors: [],
        absence_set_delta: [],
        source_reliability: 1,
        causal_sequence_marker: 1n,
        ground_truth_calibration_indicator: undefined,
        payload_integrity: 'b'.repeat(64),
      },
      { pq: keys.mldsa, classical: keys.ed25519 },
    );
    // Tamper the source_id without resigning.
    const tampered: AttestedEvent = { ...evt, source_id: 'tampered-source' };
    // Resolver now uses original source_id, but tampered event reports
    // tampered-source — resolver returns null → public-key-not-found.
    const err: AppendError = await ledger.appendEvent(tampered, resolver).catch((e) => e);
    expect(err).toBeInstanceOf(AppendError);
    // either public-key-not-found (resolver returned null for new source_id)
    // or signature-invalid if a key happened to be returned — both prove the
    // tamper was caught.
    expect(['public-key-not-found', 'signature-invalid']).toContain(err.reason);
  });

  // Regression test for the chain_heads race condition fixed in tranche 5.
  //
  // Before the fix: appendEvent's chain_heads SELECT ran without FOR UPDATE.
  // Two concurrent appenders both read the same pre-race head_marker, both
  // passed the `marker > current_head` check, both inserted distinct events
  // with the same marker, and last-write-wins on the chain_heads upsert.
  // The loser's event row existed in `events` but was unreachable from head —
  // an orphan that broke "walk head→genesis covers every event."
  //
  // After the fix: FOR UPDATE serializes the SELECT. The second writer waits
  // for the first to commit, then sees the new marker and (correctly) throws
  // sequence-marker-not-monotonic. Callers retry with a fresh head.
  //
  // This test fires N concurrent appenders against one chain and asserts:
  //   (1) exactly N events on the chain (no extras, no losses),
  //   (2) head.eventCount == N,
  //   (3) walking head→genesis visits every event (zero orphans).
  it('concurrent appendEvent on one chain produces no orphans', async () => {
    const keys = await attestation.generateKeyPair();
    const sourceId = `race-${Math.random().toString(36).slice(2, 8)}`;
    const chainId = 'test-race';
    const N = 12;

    const resolver: PublicKeyResolver = async (sid) =>
      sid === sourceId ? { pq: keys.mldsa.publicKey, classical: keys.ed25519.publicKey } : null;

    // Seed a genesis event serially so every concurrent appender has a
    // chain_heads row to lock. The genesis-event case is a known gap (the
    // FOR UPDATE locks nothing when no row exists) and is acceptable because
    // chains are bootstrapped at setup, not under concurrent traffic.
    const seedHash = await (async () => {
      const evt = await signEvent(
        {
          version: 1,
          chain_id: chainId,
          event_type: 'system-operational',
          source_id: sourceId,
          causal_predecessors: [],
          absence_set_delta: [],
          source_reliability: 1,
          causal_sequence_marker: 1n,
          ground_truth_calibration_indicator: undefined,
          payload_integrity: 'c'.repeat(64),
        },
        { pq: keys.mldsa, classical: keys.ed25519 },
      );
      return ledger.appendEvent(evt, resolver);
    })();
    expect(seedHash).toMatch(/^[0-9a-f]{64}$/);

    // Each worker: read head, sign with head_marker+1, append. On
    // sequence-marker-not-monotonic, re-read and retry. This mirrors what
    // every real caller (auth-events emission, AI-interaction emission) is
    // expected to do.
    const appendOne = async (workerId: number): Promise<string> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 20; attempt++) {
        const head = await ledger.getChainHead(chainId, sourceId);
        if (!head) throw new Error('no head — seed event missing');
        const evt = await signEvent(
          {
            version: 1,
            chain_id: chainId,
            event_type: 'system-operational',
            source_id: sourceId,
            causal_predecessors: [head.headHash],
            absence_set_delta: [],
            source_reliability: 1,
            causal_sequence_marker: head.headSequenceMarker + 1n,
            ground_truth_calibration_indicator: undefined,
            payload_integrity: workerId.toString(16).padStart(64, '0'),
          },
          { pq: keys.mldsa, classical: keys.ed25519 },
        );
        try {
          return await ledger.appendEvent(evt, resolver);
        } catch (err) {
          lastErr = err;
          const reason = err instanceof AppendError ? err.reason : '';
          if (
            reason !== 'sequence-marker-not-monotonic' &&
            reason !== 'predecessor-marker-violation'
          ) {
            throw err;
          }
          // Brief jittered backoff so retries don't lockstep.
          await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 15)));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('appendOne: exhausted retries');
    };

    // Fire all workers truly concurrently — Promise.all kicks them all off
    // before any awaits resolve.
    const hashes = await Promise.all(Array.from({ length: N }, (_, i) => appendOne(i + 1)));
    expect(new Set(hashes).size).toBe(N); // all hashes distinct

    // (1) exactly N+1 events on chain (N workers + 1 seed).
    const onChain = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM events WHERE chain_id = $1 AND source_id = $2`,
      [chainId, sourceId],
    );
    expect(Number(onChain.rows[0]!.count)).toBe(N + 1);

    // (2) head.eventCount == N+1.
    const head = await ledger.getChainHead(chainId, sourceId);
    expect(head?.eventCount).toBe(BigInt(N + 1));

    // (3) walking head→genesis visits every event — no orphans.
    // AttestedEvent doesn't carry its own hash (the hash IS the event's
    // identity, derived from its canonical bytes); recompute on the fly.
    const walkedHashes: string[] = [];
    const walkedMarkers: bigint[] = [];
    for await (const e of ledger.walkPredecessors(head!.headHash)) {
      walkedHashes.push(computeEventHash(e));
      walkedMarkers.push(e.causal_sequence_marker);
    }
    expect(walkedHashes.length).toBe(N + 1);
    expect(new Set(walkedHashes).size).toBe(N + 1);
    // Markers must be 1..N+1, no gaps — proves a single linear chain with
    // no orphans and no skipped slots.
    const sortedMarkers = [...walkedMarkers].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(sortedMarkers).toEqual(Array.from({ length: N + 1 }, (_, i) => BigInt(i + 1)));
    // Every appended hash (plus seed) must appear in the walk.
    const walkedSet = new Set(walkedHashes);
    expect(walkedSet.has(seedHash)).toBe(true);
    for (const h of hashes) expect(walkedSet.has(h)).toBe(true);
  });
});
