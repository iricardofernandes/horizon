import { z } from 'zod'

const positive = z.coerce.number().int().positive()

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: positive.max(65_535).default(3001),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.url().regex(/^postgres(?:ql)?:\/\//),
    DATABASE_POOL_MAX: positive.max(100).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: positive.max(60_000).default(5000),
    DATABASE_RELAY_URL: z
      .url()
      .regex(/^postgres(?:ql)?:\/\//)
      .optional(),
    REDIS_URL: z.url().regex(/^rediss?:\/\//),
    RABBITMQ_URL: z.url().regex(/^amqps?:\/\//),
    OUTBOX_POLL_INTERVAL_MS: positive.default(1000),
    OUTBOX_BATCH_SIZE: positive.max(1000).default(100),
    IDEMPOTENCY_TTL_SECONDS: positive.max(604_800).default(86_400),
    JWT_PRIVATE_KEY_PATH: z.string().min(1),
    JWT_PUBLIC_KEYS_DIR: z.string().min(1),
    JWT_ACTIVE_KID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    BLIND_INDEX_KEY_PATH: z.string().min(1),
    ACCESS_TOKEN_TTL_SECONDS: positive.max(900).default(900),
    REFRESH_TOKEN_ABSOLUTE_TTL_SECONDS: positive.max(31_536_000).default(2_592_000),
    REFRESH_TOKEN_IDLE_TTL_SECONDS: positive.max(31_536_000).default(604_800),
    REFRESH_TOKEN_REUSE_GRACE_MS: z.coerce.number().int().min(0).max(10_000).default(2000),
    ARGON2_MEMORY_KIB: positive.min(19_456).max(1_048_576).default(19_456),
    ARGON2_TIME_COST: positive.min(2).max(100).default(2),
    ARGON2_PARALLELISM: positive.max(255).default(1),
    API_KEY_ENV: z.enum(['dev', 'test', 'live']).default('dev'),
    DATA_SUBJECT_KEY_MODE: z.literal('table').default('table'),
    TRUST_GATEWAY_JWT: z.enum(['false']).default('false'),
    TENANT_ID_HASH_SALT: z.string().min(16),
  })
  .refine((env) => env.REFRESH_TOKEN_IDLE_TTL_SECONDS <= env.REFRESH_TOKEN_ABSOLUTE_TTL_SECONDS, {
    path: ['REFRESH_TOKEN_IDLE_TTL_SECONDS'],
    message: 'idle timeout cannot exceed absolute lifetime',
  })

export type IdentityEnvironment = z.infer<typeof environmentSchema>

/** Boot errors report invalid field names, never the environment's secret values. */
export function readEnvironment(
  source: Record<string, unknown> = process.env,
): IdentityEnvironment {
  const parsed = environmentSchema.safeParse(source)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]
    throw new Error(`Invalid identity configuration: ${fields.join(', ')}`)
  }
  return parsed.data
}
