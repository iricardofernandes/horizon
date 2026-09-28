import { z } from 'zod'

const positive = z.coerce.number().int().positive()

const environmentSchema = z
  .object({
    PORT: positive.max(65_535).default(3014),
    DATABASE_URL: z.url().regex(/^postgres(?:ql)?:\/\//),
    /** The worker and the outbox relay run as this role; without it, neither runs. */
    DATABASE_RELAY_URL: z
      .url()
      .regex(/^postgres(?:ql)?:\/\//)
      .optional(),
    DATABASE_POOL_MAX: positive.max(100).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: positive.max(60_000).default(5000),
    RABBITMQ_URL: z.url().regex(/^amqps?:\/\//),
    AMQP_PREFETCH: positive.max(1000).default(20),
    JWKS_URL: z.url().regex(/^https?:\/\//),
    ACCESS_TOKEN_MAX_AGE_SECONDS: positive.max(900).default(900),
    /** Where the encrypted bytes are kept: S3-compatible storage, or a directory. */
    FILES_STORE: z.enum(['s3', 'file']).default('s3'),
    FILES_BUCKET: z.string().min(3).default('horizon-attachments'),
    FILES_S3_ENDPOINT: z.url().default('http://localhost:9000'),
    FILES_S3_REGION: z.string().min(1).default('us-east-1'),
    FILES_FILE_ROOT: z.string().min(1).default('/tmp/horizon-attachments'),
    /** Wraps every owner key: 64 hex characters or 32 bytes in base64, never shared. */
    FILES_MASTER_KEY: z.string().min(44).max(64),
    /** Signs upload and download links; at least 32 characters, never shared. */
    FILES_LINK_SECRET: z.string().min(32),
    /** `eicar` (deterministic, for CI and tests) or `clamav` (clamd over TCP). */
    FILES_SCANNER: z.enum(['eicar', 'clamav']).default('eicar'),
    CLAMD_HOST: z.string().min(1).default('localhost'),
    CLAMD_PORT: positive.max(65_535).default(3310),
    CLAMD_TIMEOUT_MS: positive.max(300_000).default(30_000),
    FILES_SCAN_RETRY_MS: positive.min(1000).default(30_000),
    FILES_POLL_INTERVAL_MS: positive.min(500).max(600_000).default(5000),
    FILES_CLAIM_MS: positive.min(10_000).default(120_000),
  })
  .refine((config) => config.FILES_STORE !== 's3' || config.FILES_BUCKET.length > 0)

export type FilesEnvironment = z.infer<typeof environmentSchema>

export function readEnvironment(source: Record<string, unknown> = process.env): FilesEnvironment {
  const parsed = environmentSchema.safeParse(source)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]
    throw new Error(`Invalid files configuration: ${fields.join(', ')}`)
  }
  return parsed.data
}
