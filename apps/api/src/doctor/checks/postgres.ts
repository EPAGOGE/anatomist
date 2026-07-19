import pg from 'pg';
import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

export function postgresCheck(databaseUrl: string): Check {
  return makeCheck('postgres-connection', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    try {
      const result = await pool.query<{ version: string }>('select version() as version');
      const ver = result.rows[0]?.version ?? 'unknown';
      const short = ver.split(' ').slice(0, 2).join(' ');
      return short;
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
}

export function postgresMigrationsCheck(databaseUrl: string): Check {
  return makeCheck('postgres-migrations', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    try {
      // drizzle-kit stores migration history in the drizzle schema.
      const migrationsTableExists = await pool.query<{ exists: boolean }>(
        `select exists (
           select 1 from information_schema.tables
           where table_schema = 'drizzle' and table_name = '__drizzle_migrations'
         ) as exists`,
      );
      if (!migrationsTableExists.rows[0]?.exists) {
        throw new Error(
          'drizzle migrations table absent — run drizzle-kit migrate before serving requests',
        );
      }
      const result = await pool.query<{ hash: string; created_at: string }>(
        'select hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1',
      );
      const last = result.rows[0];
      if (!last) {
        throw new Error('migrations table exists but is empty');
      }
      return `last migration applied at ${last.created_at}`;
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
}

export function schemaTablesCheck(databaseUrl: string): Check {
  return makeCheck('postgres-schema-tables', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    try {
      const expected = [
        'users',
        'events',
        'event_predecessors',
        'event_absence_entries',
        'chain_heads',
        'chain_owners',
        'api_keys',
        'ai_interactions',
        'ai_budgets',
        'ai_response_cache',
        'chain_pins',
        'projects',
      ];
      const present = await pool.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_name = ANY($1::text[])`,
        [expected],
      );
      const found = new Set(present.rows.map((r) => r.table_name));
      const missing = expected.filter((t) => !found.has(t));
      if (missing.length > 0) {
        throw new Error(`expected tables missing: ${missing.join(', ')}`);
      }
      return `${expected.length} expected tables present`;
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
}
