import type { FastifyPluginAsync } from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, gte, sql } from 'drizzle-orm';
import { aiInteractions } from '../../db/schema.js';
import type { JwtKey } from '../../auth/jwt.js';
import { resolveAuth } from '../../auth/local-user.js';

export interface CostStatsPluginOptions {
  jwtKey: JwtKey;
}

export const costStatsPlugin: FastifyPluginAsync<CostStatsPluginOptions> = async (app, opts) => {
  // GET /ai/cost-stats[?group_by=day]
  //
  // Default: per-(model, tier, purpose) totals for the current month.
  // ?group_by=day: per-day totals for the current month, sorted oldest first.
  // Both modes are user-scoped — only returns the requesting user's data.
  app.get<{ Querystring: { group_by?: 'day' | 'feature' } }>(
    '/ai/cost-stats',
    async (request, reply) => {
      if (!app.pool) {
        return reply
          .code(500)
          .send({ error: { code: 'server-misconfigured', message: 'pool not wired' } });
      }
      const auth = resolveAuth(request, reply, opts.jwtKey);
      if (!auth) return;

      const periodStart = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
      );
      const db = drizzle(app.pool);
      const baseWhere = and(
        eq(aiInteractions.userId, auth.userId),
        gte(aiInteractions.occurredAt, periodStart),
      );

      const groupBy = request.query.group_by;

      if (groupBy === 'day') {
        // Postgres DATE_TRUNC('day', ...) at session time zone; we cast to
        // UTC date string for the response so clients don't have to deal
        // with timezone variance.
        const rows = await db
          .select({
            day: sql<string>`to_char(date_trunc('day', ${aiInteractions.occurredAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
            callCount: sql<string>`count(*)::text`,
            inputTokensSum: sql<string>`coalesce(sum(${aiInteractions.inputTokens}), 0)::text`,
            outputTokensSum: sql<string>`coalesce(sum(${aiInteractions.outputTokens}), 0)::text`,
            cacheReadTokensSum: sql<string>`coalesce(sum(${aiInteractions.cacheReadTokens}), 0)::text`,
            costTotalNanosSum: sql<string>`coalesce(sum(${aiInteractions.costTotalNanos}), 0)::text`,
          })
          .from(aiInteractions)
          .where(baseWhere)
          .groupBy(sql`date_trunc('day', ${aiInteractions.occurredAt} AT TIME ZONE 'UTC')`)
          .orderBy(sql`date_trunc('day', ${aiInteractions.occurredAt} AT TIME ZONE 'UTC')`);

        return reply.send({
          period_start: periodStart.toISOString(),
          group_by: 'day',
          daily: rows.map((r) => ({
            day: r.day,
            call_count: Number(r.callCount),
            input_tokens: Number(r.inputTokensSum),
            output_tokens: Number(r.outputTokensSum),
            cache_read_tokens: Number(r.cacheReadTokensSum),
            cost_total_nanos: r.costTotalNanosSum,
          })),
        });
      }

      if (groupBy === 'feature') {
        // Per-feature aggregation. Features are caller-supplied labels
        // ('composer-suggest', 'chain-event-explain', etc.); null means
        // the caller didn't tag.
        const rows = await db
          .select({
            feature: aiInteractions.feature,
            callCount: sql<string>`count(*)::text`,
            costTotalNanosSum: sql<string>`coalesce(sum(${aiInteractions.costTotalNanos}), 0)::text`,
          })
          .from(aiInteractions)
          .where(baseWhere)
          .groupBy(aiInteractions.feature)
          .orderBy(sql`coalesce(sum(${aiInteractions.costTotalNanos}), 0) desc`);

        return reply.send({
          period_start: periodStart.toISOString(),
          group_by: 'feature',
          by_feature: rows.map((r) => ({
            feature: r.feature,
            call_count: Number(r.callCount),
            cost_total_nanos: r.costTotalNanosSum,
          })),
        });
      }

      // Default: per-(model, tier, purpose) breakdown.
      const rows = await db
        .select({
          model: aiInteractions.model,
          tier: aiInteractions.tier,
          purpose: aiInteractions.purpose,
          callCount: sql<string>`count(*)::text`,
          inputTokensSum: sql<string>`coalesce(sum(${aiInteractions.inputTokens}), 0)::text`,
          outputTokensSum: sql<string>`coalesce(sum(${aiInteractions.outputTokens}), 0)::text`,
          cacheReadTokensSum: sql<string>`coalesce(sum(${aiInteractions.cacheReadTokens}), 0)::text`,
          costTotalNanosSum: sql<string>`coalesce(sum(${aiInteractions.costTotalNanos}), 0)::text`,
        })
        .from(aiInteractions)
        .where(baseWhere)
        .groupBy(aiInteractions.model, aiInteractions.tier, aiInteractions.purpose);

      return reply.send({
        period_start: periodStart.toISOString(),
        breakdown: rows.map((r) => ({
          model: r.model,
          tier: r.tier,
          purpose: r.purpose,
          call_count: Number(r.callCount),
          input_tokens: Number(r.inputTokensSum),
          output_tokens: Number(r.outputTokensSum),
          cache_read_tokens: Number(r.cacheReadTokensSum),
          cost_total_nanos: r.costTotalNanosSum,
        })),
      });
    },
  );
};
