import { z } from 'zod'

const positive = z.coerce.number().int().positive()

/**
 * Everything the process actually reads, and nothing it does not. Values reserved for
 * a consumer Catalog has not built yet — the AMQP consumer's prefetch, the inbox
 * retention sweep, the outbound HTTP client and its breaker — are documented in
 * `.env.example` and deliberately absent here: validating a setting nothing honours
 * would be a claim that it does something.
 */
const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positive.max(65_535).default(3002),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
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
  IDEMPOTENCY_SECRET: z.string().min(32),
  JWKS_URL: z.url().regex(/^https?:\/\//),
  /** The ceiling Catalog accepts, independent of what Identity currently issues. */
  ACCESS_TOKEN_MAX_AGE_SECONDS: positive.max(900).default(900),
  /** Trusting the gateway's verification would make reaching the port a bypass. */
  TRUST_GATEWAY_JWT: z.enum(['false']).default('false'),
  TENANT_ID_HASH_SALT: z.string().min(16),
})

export type CatalogEnvironment = z.infer<typeof environmentSchema>

/** Boot errors report invalid field names, never the environment's secret values. */
export function readEnvironment(source: Record<string, unknown> = process.env): CatalogEnvironment {
  const parsed = environmentSchema.safeParse(source)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]
    throw new Error(`Invalid catalog configuration: ${fields.join(', ')}`)
  }
  return parsed.data
}
