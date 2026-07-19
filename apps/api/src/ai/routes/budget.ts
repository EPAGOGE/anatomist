import type { FastifyPluginAsync } from 'fastify';
import { ensureBudgetRow } from '../budget.js';
import type { JwtKey } from '../../auth/jwt.js';
import { resolveAuth } from '../../auth/local-user.js';

export interface BudgetPluginOptions {
  jwtKey: JwtKey;
}

export const budgetPlugin: FastifyPluginAsync<BudgetPluginOptions> = async (app, opts) => {
  app.get('/ai/budget', async (request, reply) => {
    if (!app.pool) {
      return reply
        .code(500)
        .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
    }
    const auth = resolveAuth(request, reply, opts.jwtKey);
    if (!auth) return;
    const row = await ensureBudgetRow(app.pool, auth.userId);
    return reply.send({
      period_start: row.periodStart.toISOString(),
      cap_nanos: row.capNanos.toString(),
      spent_nanos: row.spentNanos.toString(),
      remaining_nanos: (row.capNanos - row.spentNanos).toString(),
      warn_at_pct: row.warnAtPct,
    });
  });
};
