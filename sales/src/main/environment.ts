import { z } from 'zod'

const positive = z.coerce.number().int().positive()

const environmentSchema = z.object({
  PORT: positive.max(65_535).default(3004),
  DATABASE_URL: z.url().regex(/^postgres(?:ql)?:\/\//),
  DATABASE_RELAY_URL: z
    .url()
    .regex(/^postgres(?:ql)?:\/\//)
    .optional(),
  DATABASE_POOL_MAX: positive.max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: positive.max(60_000).default(5000),
  RABBITMQ_URL: z.url().regex(/^amqps?:\/\//),
  JWKS_URL: z.url().regex(/^https?:\/\//),
  ACCESS_TOKEN_MAX_AGE_SECONDS: positive.max(900).default(900),
  AMQP_PREFETCH: positive.max(1000).default(20),
  OUTBOX_POLL_INTERVAL_MS: positive.min(100).default(1000),
  OUTBOX_BATCH_SIZE: positive.max(1000).default(100),
  QUOTE_DEFAULT_VALIDITY_DAYS: positive.default(15),
  CUSTOMER_BLIND_INDEX_KEY: z.string().regex(/^[0-9a-f]{64}$/),
})

export type SalesEnvironment = z.infer<typeof environmentSchema>

export function readEnvironment(source: Record<string, unknown> = process.env): SalesEnvironment {
  const parsed = environmentSchema.safeParse(source)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]
    throw new Error(`Invalid sales configuration: ${fields.join(', ')}`)
  }
  return parsed.data
}
