import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { FiscalCapabilities } from './capabilities'

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`--${name} is required`)
  return value
}

async function main(): Promise<void> {
  const databaseUrl = z.url().parse(process.env.DATABASE_URL)
  const action = z.enum(['evidence', 'activate', 'deactivate']).parse(flag('action'))
  const input = JSON.parse(await readFile(flag('file'), 'utf8'))
  const capabilities = new FiscalCapabilities(databaseUrl)
  try {
    const result =
      action === 'evidence'
        ? await capabilities.recordHomologationEvidence(input)
        : await capabilities.change({
            ...input,
            action: action === 'activate' ? 'activate_homologated' : 'deactivate',
          })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await capabilities.close()
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phase 43 activation command failed')
  process.exitCode = 1
})
