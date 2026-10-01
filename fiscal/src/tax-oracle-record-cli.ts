import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'
import { recordOracleRun } from './tax-metrics'

/**
 * Records `make tax-oracle` reports in Fiscal (Phase 89), so the service exports the last
 * run's disagreements and age as a service level.
 *
 *   DATABASE_URL=… node dist/tax-oracle-record-cli.js --by <who> <report.json>…
 */
const argv = process.argv.slice(2)
const byIndex = argv.indexOf('--by')
const by = byIndex >= 0 ? argv[byIndex + 1] : undefined
const reports = argv.filter((value, index) => index !== byIndex && index !== byIndex + 1)
const url = process.env.DATABASE_URL
if (!url || !by || reports.length === 0) {
  process.stderr.write('usage: DATABASE_URL=… tax-oracle-record-cli --by <who> <report.json>…\n')
  process.exit(2)
}
async function main(databaseUrl: string, recordedBy: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 })
  try {
    const recorded = []
    for (const path of reports) {
      const bytes = await readFile(path)
      const result = await recordOracleRun(sql, {
        report: JSON.parse(bytes.toString('utf8')),
        reportDigest: createHash('sha256').update(bytes).digest('hex'),
        recordedBy,
      })
      recorded.push({ report: path, ...result })
    }
    process.stdout.write(`${JSON.stringify(recorded, null, 2)}\n`)
  } finally {
    await sql.end()
  }
}

main(url, by).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
