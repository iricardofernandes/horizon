import { z } from 'zod'

const positive = z.coerce.number().int().positive()

const environmentSchema = z.object({
  PORT: positive.max(65_535).default(3015),
  DATABASE_URL: z.url().regex(/^postgres(?:ql)?:\/\//),
  DATABASE_POOL_MAX: positive.max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: positive.max(60_000).default(5000),
  JWKS_URL: z.url().regex(/^https?:\/\//),
  ACCESS_TOKEN_MAX_AGE_SECONDS: positive.max(900).default(900),
  /** Every exchange and every read goes through the gateway with the caller's token. */
  GATEWAY_URL: z.url().regex(/^https?:\/\//),
  GATEWAY_TIMEOUT_MS: positive.max(60_000).default(10_000),
  AGENT_MAX_ROWS: positive.max(500).default(50),
  AGENT_MAX_RESULT_BYTES: positive.min(1024).max(1_048_576).default(65_536),
  /** Erasures reach the assistant through the broker; without it, nothing is consumed. */
  RABBITMQ_URL: z
    .url()
    .regex(/^amqps?:\/\//)
    .optional(),
  /** Wraps every person's conversation key: 64 hex characters or 32 bytes of base64. */
  ASSISTANT_MASTER_KEY: z.string().min(44).max(64),
  /**
   * Master keys being retired (Phase 81), comma-separated: they still open what they wrapped,
   * and the rewrap worker moves every person key off them.
   */
  ASSISTANT_PREVIOUS_MASTER_KEYS: z.string().max(4096).default(''),
  ASSISTANT_REWRAP_INTERVAL_MS: positive.min(1000).max(86_400_000).default(60_000),
  /** `extractive` (deterministic, in the stack) or `anthropic` (needs ANTHROPIC_API_KEY). */
  ASSISTANT_GENERATOR: z.enum(['extractive', 'anthropic']).default('extractive'),
  ASSISTANT_MODEL: z.string().min(1).max(100).default('claude-opus-5-5'),
  // Compose passes an unset key as an empty string: that is no key.
  ANTHROPIC_API_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  ),
  ANTHROPIC_BASE_URL: z.url().default('https://api.anthropic.com'),
  ASSISTANT_TIMEOUT_MS: positive.max(300_000).default(60_000),
  ASSISTANT_PURGE_INTERVAL_MS: positive.min(60_000).default(3_600_000),
})

export type AgentEnvironment = z.infer<typeof environmentSchema>

export function readEnvironment(source: Record<string, unknown> = process.env): AgentEnvironment {
  const parsed = environmentSchema.safeParse(source)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]
    throw new Error(`Invalid agent configuration: ${fields.join(', ')}`)
  }
  return parsed.data
}
