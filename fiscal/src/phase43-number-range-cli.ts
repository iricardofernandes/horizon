import { readFile } from 'node:fs/promises'
import { FiscalCapabilities } from './capabilities'

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const index = process.argv.indexOf('--file')
  const file = index < 0 ? undefined : process.argv[index + 1]
  if (!file) throw new Error('--file is required')
  const input = JSON.parse(await readFile(file, 'utf8'))
  const capabilities = new FiscalCapabilities(databaseUrl)
  try {
    process.stdout.write(
      `${JSON.stringify(await capabilities.registerHomologationNumberRange(input), null, 2)}\n`,
    )
  } finally {
    await capabilities.close()
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phase 43 number range command failed')
  process.exitCode = 1
})
