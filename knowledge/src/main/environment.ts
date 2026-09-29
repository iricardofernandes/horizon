import { z } from 'zod'

const positive = z.coerce.number().int().positive()

const environmentSchema = z
  .object({
    PORT: positive.max(65_535).default(3016),
    DATABASE_URL: z.url().regex(/^postgres(?:ql)?:\/\//),
    /** The indexing worker finds its tenants as this role; without it, nothing is indexed. */
    DATABASE_RELAY_URL: z
      .url()
      .regex(/^postgres(?:ql)?:\/\//)
      .optional(),
    DATABASE_POOL_MAX: positive.max(100).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: positive.max(120_000).default(30_000),
    RABBITMQ_URL: z.url().regex(/^amqps?:\/\//),
    AMQP_PREFETCH: positive.max(1000).default(20),
    JWKS_URL: z.url().regex(/^https?:\/\//),
    ACCESS_TOKEN_MAX_AGE_SECONDS: positive.max(900).default(900),
    /** Files are read through the gateway, as the `knowledge` service client (Phase 74). */
    GATEWAY_URL: z.url().regex(/^https?:\/\//),
    GATEWAY_TIMEOUT_MS: positive.max(120_000).default(30_000),
    SERVICE_TOKEN_SECRET: z.string().min(32),
    /** Wraps every document key: 64 hex characters or 32 bytes of base64, never shared. */
    KNOWLEDGE_MASTER_KEY: z.string().min(44).max(64),
    /** `hash` (deterministic, CI and a stack without the `ai` profile) or `tei`. */
    KNOWLEDGE_EMBEDDER: z.enum(['hash', 'tei']).default('hash'),
    TEI_URL: z.url().default('http://localhost:8088'),
    KNOWLEDGE_POLL_INTERVAL_MS: positive.min(500).max(600_000).default(5000),
    KNOWLEDGE_LEASE_MS: positive.min(10_000).default(120_000),
    KNOWLEDGE_BATCH: positive.max(100).default(10),
  })
  .refine((config) => config.KNOWLEDGE_EMBEDDER !== 'tei' || Boolean(config.TEI_URL))

export type KnowledgeEnvironment = z.infer<typeof environmentSchema>

export function readEnvironment(
  source: Record<string, unknown> = process.env,
): KnowledgeEnvironment {
  const parsed = environmentSchema.safeParse(source)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]
    throw new Error(`Invalid knowledge configuration: ${fields.join(', ')}`)
  }
  return parsed.data
}
