import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { FiscalCapabilities } from './capabilities'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const action = z
    .enum(['register', 'review', 'activate', 'deactivate', 'list'])
    .parse(flag('action'))
  const capabilities = new FiscalCapabilities(databaseUrl)
  try {
    if (action === 'list') {
      const tenantId = z.uuid().parse(flag('tenant'))
      process.stdout.write(`${JSON.stringify(await capabilities.listActive(tenantId), null, 2)}\n`)
      return
    }
    const file = flag('file')
    if (!file) throw new Error('--file is required for capability mutations')
    const input = JSON.parse(await readFile(file, 'utf8'))
    const result =
      action === 'register'
        ? await capabilities.register(input)
        : action === 'review'
          ? await capabilities.review(input)
          : await capabilities.change({
              ...input,
              action: action === 'activate' ? 'activate_simulated' : 'deactivate',
            })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await capabilities.close()
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phase 42 capability command failed')
  process.exitCode = 1
})
