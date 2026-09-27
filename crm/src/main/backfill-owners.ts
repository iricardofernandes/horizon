import { z } from 'zod'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { CrmDatabase } from '@/infrastructure/database/drizzle/crm-database'

/**
 * Loads the workspace's users as CRM owners, for users that existed before CRM started
 * consuming `identity.user.*`. Only ids and whether they are active are kept — never a
 * name or an email. A user already known keeps its state, so running it again changes
 * nothing, and a disabled user is never re-enabled.
 *
 *   IDENTITY_URL=http://localhost:8000/identity IDENTITY_TOKEN=<identity admin token> \
 *     npm run backfill:owners -- --tenant <uuid>
 */
const PAGE = 100

const pageSchema = z.object({
  data: z.array(
    z.object({ id: z.uuid(), status: z.string(), createdAt: z.iso.datetime({ offset: true }) }),
  ),
  page: z.object({ hasMore: z.boolean(), nextCursor: z.string().optional() }),
})

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function* users(url: string, token: string) {
  let cursor: string | undefined
  do {
    const query = new URLSearchParams({ limit: String(PAGE), ...(cursor ? { cursor } : {}) })
    const response = await fetch(`${url.replace(/\/$/, '')}/users?${query}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`Identity users read failed with HTTP ${response.status}`)
    const page = pageSchema.parse(await response.json())
    yield* page.data
    cursor = page.page.hasMore ? page.page.nextCursor : undefined
  } while (cursor)
}

async function main(): Promise<void> {
  const tenantId = z.uuid().parse(flag('tenant'))
  const config = z
    .object({
      DATABASE_URL: z.url(),
      IDENTITY_URL: z.url(),
      IDENTITY_TOKEN: z.string().min(20),
    })
    .parse(process.env)
  const database = new CrmDatabase({
    url: config.DATABASE_URL,
    poolMax: 2,
    statementTimeoutMs: 10_000,
    secretBox: new AesGcmSecretBox(),
  })
  try {
    const seen = { active: 0, disabled: 0 }
    for await (const user of users(config.IDENTITY_URL, config.IDENTITY_TOKEN)) {
      const at = new Date(user.createdAt)
      await database.inTenant(tenantId, async (scope) => {
        await scope.owners.register(user.id, at)
        if (user.status !== 'active') await scope.owners.disable(user.id, at)
      })
      seen[user.status === 'active' ? 'active' : 'disabled'] += 1
    }
    process.stdout.write(`${JSON.stringify({ tenantId, ...seen })}\n`)
  } finally {
    await database.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
