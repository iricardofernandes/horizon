import { readFileSync } from 'node:fs'
import Redis from 'ioredis'
import postgres from 'postgres'
import { z } from 'zod'
import { policySchema } from './policy.js'
import { type Connections, type Reporter, runRetention, type Sql } from './retention.js'

const environment = z
  .object({
    RETENTION_POLICY_PATH: z.string().default('/app/policy.json'),
    /** `{database}` is replaced by a rule's module, e.g. `financial`. As the relay role. */
    RETENTION_DATABASE_URL_TEMPLATE: z.string().regex(/^postgres(?:ql)?:\/\/.*\{database\}/),
    REDIS_URL: z
      .string()
      .regex(/^rediss?:\/\//)
      .optional(),
    RETENTION_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(86_400),
    RETENTION_FIRST_DELAY_SECONDS: z.coerce.number().int().min(0).default(60),
    /** Run once and exit: for `make retention-now` and the drill. */
    RETENTION_ONCE: z.enum(['true', 'false']).default('false'),
  })
  .parse(process.env)

const policy = policySchema.parse(
  JSON.parse(readFileSync(environment.RETENTION_POLICY_PATH, 'utf8')),
)
const pools = new Map<string, Sql>()
const connections: Connections = {
  database(name) {
    let sql = pools.get(name)
    if (!sql) {
      sql = postgres(environment.RETENTION_DATABASE_URL_TEMPLATE.replace('{database}', name), {
        max: 1,
        connect_timeout: 5,
        connection: { statement_timeout: 60_000, application_name: 'horizon-retention' },
      })
      pools.set(name, sql)
    }
    return sql
  },
}

const reporter: Reporter = {
  async overdue(now, graceMinutes) {
    const before = new Date(now.getTime() - graceMinutes * 60_000)
    const [exports] = await connections.database('reporting')<{ count: number }[]>`
      select count(*)::int as count from export_jobs
      where status = 'ready' and expires_at < ${before}`
    const [attachments] = await connections.database('files')<{ count: number }[]>`
      select count(*)::int as count from attachments where due_at < ${before}`
    return { exports: exports?.count ?? 0, attachments: attachments?.count ?? 0 }
  },
  async keysWithoutTtl(prefixes) {
    if (!environment.REDIS_URL || prefixes.length === 0) return {}
    const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
    await redis.connect()
    try {
      const counts: Record<string, number> = {}
      for (const prefix of prefixes) {
        let cursor = '0'
        let missing = 0
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500)
          cursor = next
          for (const key of keys) if ((await redis.ttl(key)) === -1) missing += 1
        } while (cursor !== '0')
        counts[prefix] = missing
      }
      return counts
    } finally {
      redis.disconnect()
    }
  },
}

const log = (line: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`)

async function pass(): Promise<number> {
  const outcome = await runRetention(policy, connections, reporter, log)
  return outcome.failed.length
}

async function close() {
  await Promise.allSettled([...pools.values()].map((sql) => sql.end({ timeout: 5 })))
}

if (environment.RETENTION_ONCE === 'true') {
  const failures = await pass()
  await close()
  process.exitCode = failures ? 1 : 0
} else {
  let timer: ReturnType<typeof setTimeout>
  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      void pass()
        .catch((error: unknown) => log({ event: 'retention.error', message: String(error) }))
        .finally(() => schedule(environment.RETENTION_INTERVAL_SECONDS * 1000))
    }, delay)
  }
  schedule(environment.RETENTION_FIRST_DELAY_SECONDS * 1000)
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      clearTimeout(timer)
      void close().then(() => process.exit(0))
    })
}
