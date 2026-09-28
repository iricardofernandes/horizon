import { z } from 'zod'

const positive = z.coerce.number().int().positive()

const environmentSchema = z.object({
  PORT: positive.max(65_535).default(3007),
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
  /** How often the relay seals every tenant's history for reporting (ADR 0058). */
  JOURNAL_SEAL_INTERVAL_MS: positive.min(10_000).max(3_600_000).default(300_000),
  /** Bulk imports (ADR 0059): rows per batch, a worker's lease, and how long failures stay. */
  IMPORT_BATCH_SIZE: positive.max(1000).default(100),
  IMPORT_LEASE_MS: positive.min(1000).default(60_000),
  IMPORT_POLL_INTERVAL_MS: positive.min(100).default(1000),
  IMPORT_RETENTION_HOURS: positive.max(24 * 30).default(72),
})

export type FinancialEnvironment = z.infer<typeof environmentSchema>

export function readEnvironment(
  source: Record<string, unknown> = process.env,
): FinancialEnvironment {
  const parsed = environmentSchema.safeParse(source)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]
    throw new Error(`Invalid financial configuration: ${fields.join(', ')}`)
  }
  return parsed.data
}
