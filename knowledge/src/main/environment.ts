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
    /**
     * Master keys being retired (Phase 81), comma-separated: they still open what they
     * wrapped, and the rewrap worker moves every document key off them.
     */
    KNOWLEDGE_PREVIOUS_MASTER_KEYS: z.string().max(4096).default(''),
    /**
     * The key lexemes are hashed under; the master key when unset. Set it to the old master
     * key before rotating to keep the index as it is; a new value re-indexes every document.
     */
    // Compose passes an unset key as an empty string: that is no key.
    KNOWLEDGE_LEXEME_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(44).max(64).optional(),
    ),
    KNOWLEDGE_REWRAP_INTERVAL_MS: positive.min(1000).max(86_400_000).default(60_000),
    /** `hash` (deterministic, CI and a stack without the `ai` profile) or `tei`. */
    KNOWLEDGE_EMBEDDER: z.enum(['hash', 'tei']).default('hash'),
    TEI_URL: z.url().default('http://localhost:8088'),
    KNOWLEDGE_POLL_INTERVAL_MS: positive.min(500).max(600_000).default(5000),
    KNOWLEDGE_LEASE_MS: positive.min(10_000).default(120_000),
    KNOWLEDGE_BATCH: positive.max(100).default(10),
    /**
     * Suggestions (Phase 77): `auto` answers them only with the local model (`tei`), so a
     * stack without the `ai` profile shows none; `on` and `off` force it.
     */
    KNOWLEDGE_SUGGESTIONS: z.enum(['auto', 'on', 'off']).default('auto'),
    /** The official NCM table, as `scripts/build-ncm-table.mjs` writes it. */
    KNOWLEDGE_NCM_TABLE: z.string().min(1).default('data/ncm-table.json.gz'),
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
