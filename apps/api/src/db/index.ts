import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env.js';
import * as schema from './schema.js';

let pool: pg.Pool | null = null;
let dbInstance: NodePgDatabase<typeof schema> | null = null;

export function getDb(): NodePgDatabase<typeof schema> {
  if (dbInstance) return dbInstance;
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }
  pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  dbInstance = drizzle(pool, { schema });
  return dbInstance;
}
