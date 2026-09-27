import { z } from 'zod'
import { RebuildMetricsUseCase } from '@/application/use-cases/rebuild-metrics'
import { canonicalJson } from '@/core/audit/canonical-json'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { CrmDatabase } from '@/infrastructure/database/drizzle/crm-database'

/**
 * Rebuilds a workspace's forecast and pipeline-metric rows from the opportunity history
 * (Phase 59), in batches, printing progress, and compares every number at one fixed cutoff
 * before and after. `--verify-only` compares without writing.
 *
 * The numbers may change only when drift was found (the first run after the migration
 * finds every opportunity without rows). It exits non-zero if they changed without drift,
 * or if a verification after the rebuild still finds drift.
 *
 *   npm run rebuild:metrics -- --tenant <uuid> [--batch 200] [--verify-only]
 */
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

const print = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`)

async function main(): Promise<void> {
  const tenantId = z.uuid().parse(flag('tenant'))
  const batch = z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .parse(flag('batch') ?? 200)
  const verifyOnly = process.argv.includes('--verify-only')
  const { DATABASE_URL } = z.object({ DATABASE_URL: z.url() }).parse(process.env)
  const database = new CrmDatabase({
    url: DATABASE_URL,
    poolMax: 2,
    statementTimeoutMs: 30_000,
    secretBox: new AesGcmSecretBox(),
  })
  try {
    const cutoff = new Date()
    const before = canonicalJson(await database.metricNumbers(tenantId, cutoff))
    const result = await new RebuildMetricsUseCase(database, batch).execute(tenantId, {
      verifyOnly,
      onBatch: (progress) => print({ step: 'batch', ...progress }),
    })
    const after = canonicalJson(await database.metricNumbers(tenantId, cutoff))
    const unchanged = before === after
    const residual = verifyOnly
      ? result.drifted
      : (await new RebuildMetricsUseCase(database, batch).execute(tenantId, { verifyOnly: true }))
          .drifted
    print({ step: 'done', tenantId, cutoff, ...result, numbersUnchanged: unchanged, residual })
    const explained = unchanged || result.drifted > 0
    if (!explained || (!verifyOnly && residual > 0)) process.exitCode = 1
  } finally {
    await database.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
