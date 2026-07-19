// Chain read-permission rules.
//
// Three ownership categories per ADR-0016:
//   - platform-owned chains (reasoning-capture, system-operational,
//     auth-events, ai-interaction): any authenticated user can read
//   - user-owned chains (user-primary:<uuid>): only the owner can read
//   - team/org (Phase 2): not yet
//
// This module is the single place to ask "can this user read this chain?"
// HTTP route handlers call canReadChain() before returning chain content.

import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { chainOwners } from '../db/schema.js';

export interface ChainReadContext {
  pool: pg.Pool;
  /** The authenticated user's UUID. */
  userId: string;
  /** The chain id being requested. */
  chainId: string;
}

export type ChainReadVerdict =
  | { allowed: true; ownerType: 'platform' | 'user'; ownerEntityId: string }
  | { allowed: false; reason: 'chain-not-found' | 'forbidden' };

export async function canReadChain(ctx: ChainReadContext): Promise<ChainReadVerdict> {
  const db = drizzle(ctx.pool);
  const row = (
    await db.select().from(chainOwners).where(eq(chainOwners.chainId, ctx.chainId)).limit(1)
  )[0];
  if (!row) return { allowed: false, reason: 'chain-not-found' };

  if (row.ownerType === 'platform') {
    return { allowed: true, ownerType: 'platform', ownerEntityId: row.ownerEntityId };
  }
  if (row.ownerType === 'user' && row.ownerEntityId === ctx.userId) {
    return { allowed: true, ownerType: 'user', ownerEntityId: row.ownerEntityId };
  }
  return { allowed: false, reason: 'forbidden' };
}

/** List all chain_ids this user is allowed to read. */
export async function listReadableChains(
  pool: pg.Pool,
  userId: string,
): Promise<Array<{ chainId: string; ownerType: 'platform' | 'user'; ownerEntityId: string }>> {
  const db = drizzle(pool);
  const rows = await db.select().from(chainOwners);
  return rows
    .filter(
      (r) => r.ownerType === 'platform' || (r.ownerType === 'user' && r.ownerEntityId === userId),
    )
    .map((r) => ({
      chainId: r.chainId,
      ownerType: r.ownerType as 'platform' | 'user',
      ownerEntityId: r.ownerEntityId,
    }));
}
