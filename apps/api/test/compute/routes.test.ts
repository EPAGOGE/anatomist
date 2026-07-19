import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { computePlugin } from '../../src/compute/routes.js';
import { loadJwtKey, issueAccessToken } from '../../src/auth/jwt.js';

// The /compute pricing routes touch no database, so we can register just this
// plugin and mint a token directly — a real inject test that runs anywhere,
// unlike the DB-live-gated route tests. Assumes no live RUNPOD_API_KEY in the
// environment (the CI/sandbox default), so prices come from the reference catalog.
const key = loadJwtKey('a'.repeat(64));
const token = issueAccessToken({ userId: 'u1', sourceId: 's1', ttlSeconds: 300 }, key);
const auth = { authorization: `Bearer ${token}` };

describe('compute routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(computePlugin, { jwtKey: key });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /compute/gpus returns the catalog with reference prices', async () => {
    const res = await app.inject({ method: 'GET', url: '/compute/gpus', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      provider: string;
      gpus: Array<{ id: string; display_name: string; vram_gb: number; usd_per_hour: number }>;
    };
    expect(body.provider).toBe('runpod');
    expect(body.gpus.length).toBeGreaterThan(0);
    expect(body.gpus.find((g) => g.id === 'A100_80GB')?.usd_per_hour).toBe(1.64);
  });

  it('POST /compute/estimate prices a run in nano-USD', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/compute/estimate',
      headers: auth,
      payload: { gpu: 'A100_80GB', gpu_count: 2, hours: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reference_price: boolean;
      total_nanos: string;
      total_usd_display: string;
    };
    expect(body.reference_price).toBe(true); // no live key
    expect(body.total_nanos).toBe('9840000000'); // $1.64 * 2 GPUs * 3h = $9.84
    expect(body.total_usd_display).toBe('$9.8400');
  });

  it('POST /compute/estimate rejects an unknown GPU with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/compute/estimate',
      headers: auth,
      payload: { gpu: 'nope' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/compute/gpus' });
    expect(res.statusCode).toBe(401);
  });
});
