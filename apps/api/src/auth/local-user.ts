// Local-first identity.
//
// The app has no login. Every request that arrives WITHOUT a Bearer token
// acts as the owner: a real users row provisioned once at boot through the
// exact same transactional registration path an HTTP user would take
// (keypair, user-primary chain, genesis event). Chains, projects, signing,
// and per-user scoping all behave identically to a registered user.
//
// Requests that DO present a Bearer token are still verified normally, so
// a hosted multi-user variant can layer real auth back on top without
// touching the route handlers again.

import crypto from 'node:crypto';
import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { registerHttpUser } from './register-http-user.js';
import { userPrimaryChainId } from '@epagoge/ledger';
import type { MasterKey } from './master-key.js';

export interface LocalIdentity {
  userId: string;
  sourceId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    localIdentity?: LocalIdentity;
  }
}

const LOCAL_EMAIL = 'local@anatomist.localhost';

/** Find-or-create the local owner user. Idempotent; called once at boot. */
export async function ensureLocalUser(pool: pg.Pool, master: MasterKey): Promise<LocalIdentity> {
  const db = drizzle(pool);
  const rows = await db.select().from(users).where(eq(users.emailLower, LOCAL_EMAIL)).limit(1);
  const existing = rows[0];
  if (existing) return { userId: existing.id, sourceId: existing.sourceId };

  try {
    const created = await registerHttpUser({
      pool,
      master,
      email: LOCAL_EMAIL,
      // Login is removed from the product; the password is never used again.
      // Random so the row is still well-formed for the argon2id column.
      password: crypto.randomBytes(32).toString('hex'),
      displayName: 'Local',
      sourceId: crypto.randomUUID(),
    });
    return { userId: created.userId, sourceId: created.sourceId };
  } catch (err) {
    // Find-or-create race: concurrent boots (parallel test files, multi-
    // process launches) can both miss the select and race the insert; the
    // loser hits the unique email constraint. The winner's row is the
    // canonical identity — re-read it and proceed.
    const again = await db.select().from(users).where(eq(users.emailLower, LOCAL_EMAIL)).limit(1);
    const winner = again[0];
    if (winner) return { userId: winner.id, sourceId: winner.sourceId };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shared request-auth resolver for inline-handler routes: Bearer token when
// presented (verified normally), local owner otherwise. Sends the 401 itself
// and returns null when neither is available.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken, type JwtKey } from './jwt.js';

export function resolveAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  jwtKey: JwtKey,
): LocalIdentity | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    const local = request.server.localIdentity;
    if (local) return local;
    reply.code(401).send({ error: { code: 'auth-required', message: 'bearer token required' } });
    return null;
  }
  const v = verifyToken(header.slice('Bearer '.length), jwtKey, { expectType: 'access' });
  if (!v.ok) {
    reply.code(401).send({ error: { code: 'invalid-token', message: 'token rejected' } });
    return null;
  }
  return { userId: v.claims.sub, sourceId: v.claims.sid };
}

/** Full profile for GET /me — the shape the web auth store persists. */
export async function loadProfile(pool: pg.Pool, identity: LocalIdentity) {
  const db = drizzle(pool);
  const rows = await db.select().from(users).where(eq(users.id, identity.userId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    source_id: row.sourceId,
    email: row.email,
    display_name: row.displayName,
    chain_id: userPrimaryChainId(row.id),
  };
}
