// Verifiable export — covers /export/me end-to-end against the live DB.
//
// The export should round-trip: every event in the bundle should
// independently verify against the included public keys. This test
// re-implements the verification locally and asserts it passes for
// every event in the returned bundle.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import Redis from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPostgresLedger } from '@epagoge/ledger';
import { attestation } from '@epagoge/crypto';
import { encodeCanonicalCbor } from '@epagoge/shared';
import { blake3 } from '@epagoge/crypto';
import { buildServer } from '../../src/server.js';
import { ensureLocalIdentity } from '../../src/identity/local-key-store.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://epagoge:epagoge_dev@localhost:5432/epagoge';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function dbReachable(): Promise<boolean> {
  const probe = new pg.Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    const c = await probe.connect();
    c.release();
    await probe.end();
    return true;
  } catch {
    await probe.end().catch(() => undefined);
    return false;
  }
}

const live = await dbReachable();
const describeLive = live ? describe : describe.skip;

process.env.JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(32).toString('hex');
process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY ?? randomBytes(32).toString('hex');

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

describeLive('Verifiable export (live)', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const ledger = createPostgresLedger({ pool });

  type FastifyApp = Awaited<ReturnType<typeof buildServer>>;
  let app: FastifyApp;
  let accessToken: string;

  beforeAll(async () => {
    const { identity } = await ensureLocalIdentity('local_user');
    app = await buildServer({
      deps: { pool, redis, ledger, platformIdentity: identity },
      disableAuthRateLimit: true,
    });
    await app.ready();

    const email = `t_${randomUUID().slice(0, 8)}@epagoge-test.local`;
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'sufficiently-long-pass', display_name: 'Export Tester' },
    });
    expect(reg.statusCode).toBe(201);
    accessToken = reg.json().access_token;
  });

  afterAll(async () => {
    await app.close();
    await ledger.close();
    redis.disconnect();
    await pool.end();
  });

  it('GET /export/me returns a verifiable bundle', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/export/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const bundle = res.json();

    expect(bundle.bundle_version).toBe(1);
    expect(bundle.subject).toMatchObject({
      user_id: expect.any(String),
      source_id: expect.any(String),
    });
    expect(Array.isArray(bundle.chains)).toBe(true);
    expect(Object.keys(bundle.keys).length).toBeGreaterThan(0);
    expect(typeof bundle.verification_instructions).toBe('string');
  });

  it('GET /export/me tokenless acts as the local owner (local-first)', async () => {
    const res = await app.inject({ method: 'GET', url: '/export/me' });
    expect(res.statusCode).not.toBe(401);
  });

  it('every event in the bundle independently verifies against the included keys', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/export/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const bundle = res.json();

    // Build a public-key lookup from the bundle.
    const keys = new Map<string, { pq: Uint8Array; classical: Uint8Array }>();
    for (const [sourceId, keyEntry] of Object.entries(
      bundle.keys as Record<
        string,
        {
          pq_public_key_b64: string;
          classical_public_key_b64: string;
        }
      >,
    )) {
      keys.set(sourceId, {
        pq: new Uint8Array(Buffer.from(keyEntry.pq_public_key_b64, 'base64')),
        classical: new Uint8Array(Buffer.from(keyEntry.classical_public_key_b64, 'base64')),
      });
    }

    let verifiedCount = 0;
    for (const chain of bundle.chains as Array<{ events: Array<Record<string, unknown>> }>) {
      for (const ev of chain.events) {
        // Reconstruct the signing payload (event minus attestation_signature).
        const signingPayload = {
          version: ev.version,
          chain_id: ev.chain_id,
          event_type: ev.event_type,
          source_id: ev.source_id,
          causal_predecessors: ev.causal_predecessors,
          absence_set_delta: (
            ev.absence_set_delta as Array<{
              expected_hash: string;
              window_start: string;
              window_end: string;
            }>
          ).map((a) => ({
            expected_hash: a.expected_hash,
            window_start: BigInt(a.window_start),
            window_end: BigInt(a.window_end),
          })),
          source_reliability: ev.source_reliability,
          causal_sequence_marker: BigInt(ev.causal_sequence_marker as string),
          ground_truth_calibration_indicator: ev.ground_truth_calibration_indicator,
          payload_integrity: ev.payload_integrity,
        };

        const signingBytes = encodeCanonicalCbor(signingPayload);
        const keypair = keys.get(ev.source_id as string);
        expect(keypair, `keys missing for source ${ev.source_id as string}`).toBeDefined();

        const sigPq = new Uint8Array(Buffer.from(ev.signature_pq_b64 as string, 'base64'));
        const sigClassical = new Uint8Array(
          Buffer.from(ev.signature_classical_b64 as string, 'base64'),
        );
        const ok = await attestation.verify(
          signingBytes,
          { pq: sigPq, classical: sigClassical },
          { mldsa: keypair!.pq, ed25519: keypair!.classical },
        );
        expect(ok, `event ${ev.event_hash as string} failed verification`).toBe(true);
        verifiedCount++;
      }
    }
    // We registered a user — at minimum the user-primary-genesis event
    // exists, plus all platform chains the user can read.
    expect(verifiedCount).toBeGreaterThan(0);
  });

  it('included public-key fingerprints match BLAKE3 of the raw keys', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/export/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const bundle = res.json();

    for (const keyEntry of Object.values(
      bundle.keys as Record<
        string,
        {
          pq_blake3: string;
          classical_blake3: string;
          pq_public_key_b64: string;
          classical_public_key_b64: string;
        }
      >,
    )) {
      const pqBytes = new Uint8Array(Buffer.from(keyEntry.pq_public_key_b64, 'base64'));
      const classicalBytes = new Uint8Array(
        Buffer.from(keyEntry.classical_public_key_b64, 'base64'),
      );
      expect(bytesToHex(blake3.hash(pqBytes))).toBe(keyEntry.pq_blake3);
      expect(bytesToHex(blake3.hash(classicalBytes))).toBe(keyEntry.classical_blake3);
    }
  });
});
