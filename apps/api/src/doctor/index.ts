import type { Check, CheckContext, DoctorReport } from './types.js';
import { runChecks, makeSkip } from './runner.js';
import { nodeVersionCheck, envVarsCheck } from './checks/basic.js';
import { postgresCheck, postgresMigrationsCheck, schemaTablesCheck } from './checks/postgres.js';
import { redisCheck } from './checks/redis.js';
import { blake3Check, ed25519Check, mldsaCheck, hybridAttestationCheck } from './checks/crypto.js';
import { cborRoundtripCheck, reliabilityCheck, schemaValidationCheck } from './checks/shared.js';
import { ledgerEndToEndCheck } from './checks/ledger.js';
import { reasoningChainCheck } from './checks/reasoning-chain.js';
import { systemOperationalChainCheck } from './checks/system-operational-chain.js';
import { userPrimaryChainCheck } from './checks/user-primary-chain.js';
import { authEventsChainCheck } from './checks/auth-events-chain.js';
import { argon2idCheck, jwtCheck, refreshTokenRedisCheck } from './checks/auth.js';
import {
  anthropicReachableCheck,
  modelRoutingCheck,
  costKnownValuesCheck,
  aiInteractionChainCheck,
  costTrackingRoundtripCheck,
} from './checks/ai.js';
import { crossChainProvenanceCheck } from './checks/cross-chain-provenance.js';
import { emissionDisciplineCheck } from './checks/emission-discipline.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export { runChecks, formatReport, makeCheck, makeSkip } from './runner.js';
export type {
  Check,
  CheckResult,
  CheckOk,
  CheckFail,
  CheckSkip,
  DoctorReport,
  CheckContext,
} from './types.js';

export interface DoctorOptions {
  /** Skip Postgres-dependent checks. */
  readonly skipDatabase?: boolean;
  /** Skip Redis-dependent checks. */
  readonly skipRedis?: boolean;
  /** Per-check timeout (default 30s). */
  readonly timeoutMs?: number;
}

/**
 * Build the default check list. Phase-specific checks (Anthropic reachable,
 * Pusher reachable, etc.) get appended here as later phases land.
 */
export function buildDefaultChecks(options: DoctorOptions = {}): readonly Check[] {
  const checks: Check[] = [
    nodeVersionCheck,
    envVarsCheck,
    blake3Check,
    ed25519Check,
    mldsaCheck,
    hybridAttestationCheck,
    cborRoundtripCheck,
    reliabilityCheck,
    schemaValidationCheck,
    argon2idCheck,
    modelRoutingCheck,
    costKnownValuesCheck,
  ];
  if (process.env.JWT_SECRET) {
    checks.push(jwtCheck);
  } else {
    checks.push(makeSkip('jwt-roundtrip', 'JWT_SECRET not set'));
  }
  if (process.env.ANTHROPIC_API_KEY) {
    checks.push(anthropicReachableCheck);
  } else {
    checks.push(makeSkip('anthropic-reachable', 'ANTHROPIC_API_KEY not set'));
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (options.skipDatabase || !databaseUrl) {
    checks.push(makeSkip('postgres-connection', 'DATABASE_URL not set or skipped'));
    checks.push(makeSkip('postgres-migrations', 'DATABASE_URL not set or skipped'));
    checks.push(makeSkip('postgres-schema-tables', 'DATABASE_URL not set or skipped'));
    checks.push(makeSkip('ledger-end-to-end', 'DATABASE_URL not set or skipped'));
    checks.push(makeSkip('reasoning-capture-chain-head', 'DATABASE_URL not set or skipped'));
    checks.push(makeSkip('system-operational-chain-head', 'DATABASE_URL not set or skipped'));
    checks.push(makeSkip('user-primary-chain-head', 'DATABASE_URL not set or skipped'));
    checks.push(makeSkip('auth-events-chain-head', 'DATABASE_URL not set or skipped'));
    checks.push(makeSkip('ai-interaction-chain-head', 'DATABASE_URL not set or skipped'));
    checks.push(makeSkip('cost-tracking-roundtrip', 'DATABASE_URL not set or skipped'));
    checks.push(makeSkip('adr-chain-alignment', 'DATABASE_URL not set or skipped'));
    checks.push(makeSkip('cross-chain-provenance-lint', 'DATABASE_URL not set or skipped'));
  } else {
    checks.push(
      postgresCheck(databaseUrl),
      postgresMigrationsCheck(databaseUrl),
      schemaTablesCheck(databaseUrl),
      ledgerEndToEndCheck(databaseUrl),
      reasoningChainCheck(databaseUrl),
      systemOperationalChainCheck(databaseUrl),
      userPrimaryChainCheck(databaseUrl),
      authEventsChainCheck(databaseUrl),
      aiInteractionChainCheck(databaseUrl),
      costTrackingRoundtripCheck(databaseUrl),
      crossChainProvenanceCheck(databaseUrl),
      emissionDisciplineCheck(resolve(HERE, '..')),
    );
  }

  const redisUrl = process.env.REDIS_URL;
  if (options.skipRedis || !redisUrl) {
    checks.push(makeSkip('redis-connection', 'REDIS_URL not set or skipped'));
    checks.push(makeSkip('refresh-token-redis', 'REDIS_URL not set or skipped'));
  } else {
    checks.push(redisCheck(redisUrl), refreshTokenRedisCheck(redisUrl));
  }

  return checks;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks = buildDefaultChecks(options);
  const ctx: CheckContext = {};
  if (options.timeoutMs !== undefined) {
    (ctx as { timeoutMs: number }).timeoutMs = options.timeoutMs;
  }
  return runChecks(checks, ctx);
}
