import pg from 'pg';
import Redis from 'ioredis';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://epagoge:epagoge_dev@localhost:5432/epagoge';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const { rows } = await pool.query<{ version: string }>('select version()');
console.log(`✓ Postgres: ${rows[0]?.version?.split(' ').slice(0, 2).join(' ') ?? '?'}`);
await pool.end();

const redis = new Redis(REDIS_URL);
const pong = await redis.ping();
console.log(`✓ Redis: ${pong}`);
redis.disconnect();
