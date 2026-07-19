import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  // 32-byte (256-bit) symmetric secret, hex-encoded (64 hex chars). Used to
  // sign HS256 JWTs. Required when auth routes are mounted; tests that don't
  // exercise auth can omit it.
  JWT_SECRET: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'JWT_SECRET must be a 64-char hex string (32 bytes)')
    .optional(),
  // 32-byte AES-256 master key used to envelope-encrypt per-user secret
  // attestation keys at rest (see ADR-0020). Required when registration is
  // mounted. Hex-encoded (64 hex chars).
  MASTER_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'MASTER_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)')
    .optional(),
  // Access-token lifetime. Short (15 min default) so a stolen access token
  // is bounded; refresh tokens carry the long-lived auth.
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Refresh-token lifetime. 30 days default; matches typical web app posture.
  JWT_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 30),
});

export type Env = z.infer<typeof EnvSchema>;

// Lazy proxy around the schema so process.env mutations that happen after
// this module is imported (e.g. test files setting JWT_SECRET at top level
// AFTER they `import { buildServer }`) still take effect. The cost is one
// schema parse per env-field access, which is negligible — env is read at
// boot and a handful of times per request at most, not in hot loops.
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string | symbol) {
    const parsed = EnvSchema.parse(process.env);
    return parsed[prop as keyof Env];
  },
});
