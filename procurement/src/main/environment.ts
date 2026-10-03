import { z } from 'zod'

const positive = z.coerce.number().int().positive()

const environmentSchema = z.object({
  PORT: positive.max(65_535).default(3010),
  DATABASE_URL: z.url().regex(/^postgres(?:ql)?:\/\//),
  DATABASE_RELAY_URL: z
    .url()
    .regex(/^postgres(?:ql)?:\/\//)
    .optional(),
  DATABASE_POOL_MAX: positive.max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: positive.max(60_000).default(5000),
  RABBITMQ_URL: z.url().regex(/^amqps?:\/\//),
  JWKS_URL: z.url().regex(/^https?:\/\//),
  /** Where Fiscal is read back from, with the caller's token (Phase 91). */
  GATEWAY_URL: z
    .url()
    .regex(/^https?:\/\//)
    .default('http://localhost:8000'),
  ACCESS_TOKEN_MAX_AGE_SECONDS: positive.max(900).default(900),
  AMQP_PREFETCH: positive.max(1000).default(20),
  OUTBOX_POLL_INTERVAL_MS: positive.min(100).default(1000),
  OUTBOX_BATCH_SIZE: positive.max(1000).default(100),
  /** How often the relay seals every tenant's history for reporting (ADR 0058). */
  JOURNAL_SEAL_INTERVAL_MS: positive.min(10_000).max(3_600_000).default(300_000),
})

export type ProcurementEnvironment = z.infer<typeof environmentSchema>

export function readEnvironment(
  source: Record<string, unknown> = process.env,
): ProcurementEnvironment {
  const parsed = environmentSchema.safeParse(source)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]
    throw new Error(`Invalid procurement configuration: ${fields.join(', ')}`)
  }
  return parsed.data
}
