import { readFileSync } from 'node:fs'
import { VerifyAuditChainUseCase } from '@/application/use-cases/verify-audit-chain'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { IdentityDatabase } from '@/infrastructure/database/drizzle/identity-database'

async function main(): Promise<void> {
  const tenantId = process.argv[2]
  if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId))
    throw new Error('Usage: npm run audit:verify -- <tenant-uuid>')
  const url = process.env.DATABASE_URL
  const keyPath = process.env.BLIND_INDEX_KEY_PATH
  if (!url || !keyPath) throw new Error('DATABASE_URL and BLIND_INDEX_KEY_PATH are required')
  const hexKey = readFileSync(keyPath, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/i.test(hexKey))
    throw new Error('Blind index key must contain 32 bytes encoded as hex')
  const db = new IdentityDatabase({
    url,
    blindIndexKey: Buffer.from(hexKey, 'hex'),
    secretBox: new AesGcmSecretBox(),
    poolMax: 1,
  })
  try {
    const result = await new VerifyAuditChainUseCase(db).execute({ tenantId })
    if (result.isLeft()) throw result.value
    process.stdout.write(`${JSON.stringify(result.value)}\n`)
    if (!result.value.intact) process.exitCode = 1
  } finally {
    await db.close()
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Audit verification failed'}\n`)
  process.exitCode = 1
})
