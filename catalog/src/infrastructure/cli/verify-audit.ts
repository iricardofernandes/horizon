import { VerifyAuditChainUseCase } from '@/application/use-cases/verify-audit-chain'
import { CatalogDatabase } from '@/infrastructure/database/drizzle/catalog-database'

async function main(): Promise<void> {
  const tenantId = process.argv[2]
  if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId))
    throw new Error('Usage: npm run audit:verify -- <tenant-uuid>')
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  const database = new CatalogDatabase({ url, poolMax: 1 })
  try {
    const result = await new VerifyAuditChainUseCase(database).execute({ tenantId })
    if (result.isLeft()) throw result.value
    process.stdout.write(`${JSON.stringify(result.value)}\n`)
    // A broken chain must fail a pipeline, not merely print.
    if (!result.value.intact) process.exitCode = 1
  } finally {
    await database.close()
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Audit verification failed'}\n`)
  process.exitCode = 1
})
