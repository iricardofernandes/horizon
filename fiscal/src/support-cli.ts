import { z } from 'zod'
import { FiscalSupport, SUPPORT_COMMAND_LIMIT } from './support'

const USAGE = `usage: node dist/support-cli.js <command> --tenant <uuid> --actor <id> [options]

commands:
  overview                       print the tenant support snapshot
  reconcile-unknown [--limit N]  consult documents whose outcome is unknown
  retry-due [--limit N]          bring forward pending jobs waiting on backoff
  replay-outbox --reason <text> (--document <uuid> | --events <uuid,uuid>) [--limit N]
                                 republish delivered events under their own ids

Every command is bounded (at most ${SUPPORT_COMMAND_LIMIT} rows), audited, and reuses an
idempotent path: it cannot create a document, a number, stock or money.`

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V })
}

async function main(): Promise<void> {
  const command = process.argv[2]
  const databaseUrl = z.url().parse(process.env.DATABASE_URL)
  const tenantId = z.uuid().parse(flag('tenant'))
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(SUPPORT_COMMAND_LIMIT)
    .default(25)
    .parse(flag('limit'))
  const support = new FiscalSupport(databaseUrl)
  try {
    if (command === 'overview') {
      process.stdout.write(`${JSON.stringify(await support.overview(tenantId), null, 2)}\n`)
      return
    }
    const actorId = `support:${z.string().min(1).max(180).parse(flag('actor'))}`
    const result =
      command === 'reconcile-unknown'
        ? await support.reconcileUnknown(tenantId, actorId, limit)
        : command === 'retry-due'
          ? await support.retryDue(tenantId, actorId, limit)
          : command === 'replay-outbox'
            ? await support.replayOutbox(tenantId, actorId, {
                reason: z.string().parse(flag('reason')),
                limit,
                ...optional('documentId', flag('document')),
                ...optional('eventIds', flag('events')?.split(',')),
              })
            : null
    if (!result) {
      process.stderr.write(`${USAGE}\n`)
      process.exitCode = 2
      return
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await support.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof z.ZodError ? USAGE : error instanceof Error ? error.message : 'Support command failed'}\n`,
  )
  process.exitCode = 1
})
