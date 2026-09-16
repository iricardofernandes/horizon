import { z } from 'zod'

const positive = z.coerce.number().int().positive()

const environmentSchema = z.object({
  PORT: positive.max(65_535).default(3007),
  DATABASE_URL: z.url().regex(/^postgres(?:ql)?:\/\//),
  DATABASE_POOL_MAX: positive.max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: positive.max(60_000).default(5000),
  JWKS_URL: z.url().regex(/^https?:\/\//),
  ACCESS_TOKEN_MAX_AGE_SECONDS: positive.max(900).default(900),
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
