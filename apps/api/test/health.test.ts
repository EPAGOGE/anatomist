import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

describe('health endpoints', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET /health/live returns 200 with no dependencies', async () => {
    app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready returns 200 with no dependencies wired', async () => {
    app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; checks: unknown[] };
    expect(body.status).toBe('ready');
    expect(body.checks).toEqual([]);
  });

  it('GET /health/ready reports failures with 503 when a dep is broken', async () => {
    const fakeRedis = {
      ping: async () => {
        throw new Error('connection refused');
      },
    } as unknown as import('ioredis').default;
    app = await buildServer({ deps: { redis: fakeRedis } });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as {
      status: string;
      checks: Array<{ name: string; ok: boolean; detail?: string }>;
    };
    expect(body.status).toBe('not-ready');
    expect(body.checks).toContainEqual(expect.objectContaining({ name: 'redis', ok: false }));
  });

  it('GET /health (legacy alias) still returns 200', async () => {
    app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
