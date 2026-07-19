// Side-effect import: loads .env (if present) BEFORE any module accesses
// env vars. Must be first.
import './load-env.js';

import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { PublicKeyResolver } from '@epagoge/ledger';
import { env } from './env.js';
import { buildDefaultServer } from './server.js';
import { ensureLocalIdentity } from './identity/local-key-store.js';
import { emitSystemOperationalEvent } from './lifecycle/system-events.js';
import { users } from './db/schema.js';

const LOCAL_USER_SOURCE_ID = 'local_user';

async function main() {
  const { app, pool, redis, ledger } = await buildDefaultServer();
  const startedAt = performance.now();

  // Load the persistent local identity that signs system-operational events.
  const { identity } = await ensureLocalIdentity(LOCAL_USER_SOURCE_ID);

  const db = drizzle(pool);
  const resolveKeys: PublicKeyResolver = async (sid) => {
    if (sid !== LOCAL_USER_SOURCE_ID) return null;
    const rows = await db.select().from(users).where(eq(users.sourceId, sid)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      pq: new Uint8Array(row.attestationPublicKeyPq),
      classical: new Uint8Array(row.attestationPublicKeyClassical),
    };
  };

  // ADR-0013: emit server-started BEFORE app.listen(). Failure here blocks
  // boot — the operational state must be reflected on-chain.
  await emitSystemOperationalEvent(
    { ledger, identity, resolveKeys },
    {
      kind: 'server-started',
      details: {
        host: env.HOST,
        port: env.PORT,
        node_version: process.versions.node,
        pid: process.pid,
      },
    },
  );

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, 'shutdown received');
    const uptimeSeconds = (performance.now() - startedAt) / 1000;
    try {
      await emitSystemOperationalEvent(
        { ledger, identity, resolveKeys },
        {
          kind: 'server-stopped',
          details: { signal, uptime_seconds: uptimeSeconds },
        },
      );
    } catch (err) {
      app.log.error({ err }, 'failed to emit server-stopped event during shutdown');
    }
    await app.close();
    await ledger.close();
    redis.disconnect();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
