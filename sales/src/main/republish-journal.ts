import postgres from 'postgres'
import { z } from 'zod'
import { openReplayQueue, replayJournal } from '@/infrastructure/messaging/journal-replay'

/**
 * Resends this module's history to `reporting/` and seals it (ADR 0058, Phase 61).
 *
 *   npm run republish:journal -- --tenant <uuid> [--since <iso>] [--until <iso>] [--seal-only]
 */
const instant = z.iso.datetime({ offset: true })

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const tenantId = z.uuid().parse(flag('tenant'))
  const since = instant.optional().parse(flag('since'))
  const until = instant.optional().parse(flag('until'))
  const config = z.object({ DATABASE_RELAY_URL: z.url(), RABBITMQ_URL: z.url() }).parse(process.env)
  const sql = postgres(config.DATABASE_RELAY_URL, {
    max: 1,
    connect_timeout: 5,
    connection: { statement_timeout: 30_000 },
  })
  const queue = await openReplayQueue(config.RABBITMQ_URL)
  try {
    const { sent, seal } = await replayJournal(sql, queue.deliver, {
      tenantId,
      since: since ? new Date(since) : null,
      until: until ? new Date(until) : null,
      sealOnly: process.argv.includes('--seal-only'),
      now: new Date(),
    })
    process.stdout.write(
      `${JSON.stringify({ source: seal.source, tenantId, sent, through: seal.through, count: seal.count })}\n`,
    )
  } finally {
    await queue.close().catch(() => undefined)
    await sql.end({ timeout: 5 })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
