import { z } from 'zod'

const positive = z.coerce.number().int().positive()

const environmentSchema = z.object({
  PORT: positive.max(65_535).default(3013),
  DATABASE_URL: z.url().regex(/^postgres(?:ql)?:\/\//),
  /** The export worker asks which tenants have work as this role; without it, it does not run. */
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
  /** Where owners' reports are read, with the caller's token (Phase 62). */
  GATEWAY_URL: z
    .url()
    .regex(/^https?:\/\//)
    .default('http://localhost:8000'),
  /** Where export files are kept (Phase 63): S3-compatible storage, or a directory. */
  EXPORT_STORE: z.enum(['s3', 'file']).default('s3'),
  EXPORT_BUCKET: z.string().min(3).default('horizon-exports'),
  EXPORT_S3_ENDPOINT: z.url().default('http://localhost:9000'),
  EXPORT_S3_REGION: z.string().min(1).default('us-east-1'),
  EXPORT_FILE_ROOT: z.string().min(1).default('/tmp/horizon-exports'),
  /** Signs download links; at least 32 characters, never shared with another service. */
  EXPORT_LINK_SECRET: z.string().min(32),
  EXPORT_RETENTION_HOURS: positive.max(24 * 90).default(72),
  EXPORT_SETTLE_GRACE_MS: positive.max(86_400_000).default(3_600_000),
  EXPORT_POLL_INTERVAL_MS: positive.min(500).max(600_000).default(5000),
  EXPORT_LEASE_MS: positive.min(60_000).default(600_000),
  /**
   * The reporting service client's secret (Phase 69): with it, scheduled controls ask
   * Identity for a read-only token per tenant. Without it, nothing runs on a schedule.
   */
  SERVICE_TOKEN_SECRET: z.string().min(32).optional(),
  CONTROLS_INTERVAL_SECONDS: positive
    .min(60)
    .max(7 * 86_400)
    .default(86_400),
  CONTROLS_FIRST_DELAY_SECONDS: positive.max(86_400).default(300),
})

export type ReportingEnvironment = z.infer<typeof environmentSchema>

export function readEnvironment(
  source: Record<string, unknown> = process.env,
): ReportingEnvironment {
  const parsed = environmentSchema.safeParse(source)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]
    throw new Error(`Invalid reporting configuration: ${fields.join(', ')}`)
  }
  return parsed.data
}
