import { z } from 'zod'
import { HomologationObservations } from './homologation-observations'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const tenantId = z.uuid().parse(flag('tenant'))
  const documentId = z.uuid().parse(flag('document'))
  const observations = new HomologationObservations(databaseUrl)
  try {
    process.stdout.write(
      `${JSON.stringify(await observations.list(tenantId, documentId), null, 2)}\n`,
    )
  } finally {
    await observations.close()
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phase 43 observation command failed')
  process.exitCode = 1
})
