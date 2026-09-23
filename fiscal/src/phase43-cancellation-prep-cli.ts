import { readFile } from 'node:fs/promises'
import { S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { EncryptedFiscalArtifactStore, S3ObjectStore } from './artifact-store'
import { FiscalArtifacts } from './artifacts'
import { FiscalCapabilities } from './capabilities'
import { HomologationCancellation } from './homologation-cancellation'
import { HomologationExchangeLedger } from './homologation-exchange-ledger'
import { loadHomologationCredential } from './nfe55/homologation-credential'
import { SefazNfe55HomologationAdapter, type SefazOperationMap } from './nfe55/sefaz-adapter'
import { digestSchema, operationsSchema } from './phase43-runtime-input'

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`--${name} is required`)
  return value
}

async function main(): Promise<void> {
  const databaseUrl = z.url().parse(process.env.DATABASE_URL)
  const key = Buffer.from(
    digestSchema.parse(process.env.FISCAL_ARTIFACT_KEY_HEX?.toLowerCase()),
    'hex',
  )
  const bucket = z.string().min(3).parse(process.env.FISCAL_ARTIFACT_BUCKET)
  const region = z.string().min(1).parse(process.env.FISCAL_ARTIFACT_REGION)
  const endpoint = process.env.FISCAL_ARTIFACT_ENDPOINT || undefined
  const tenantId = z.uuid().parse(flag('tenant'))
  const documentId = z.uuid().parse(flag('document'))
  const exchangeId = z.uuid().parse(flag('exchange'))
  const actorId = z.string().min(1).max(200).parse(flag('actor'))
  const reason = z.string().trim().min(15).max(255).parse(flag('reason'))
  const occurredAt = flag('occurred-at')
  const [credential, schemaZip, operations] = await Promise.all([
    loadHomologationCredential({
      certificatePath: flag('certificate'),
      privateKeyPath: flag('private-key'),
      expectedFingerprint: flag('certificate-fingerprint'),
      expectedIssuerTaxId: flag('issuer-tax-id'),
    }),
    readFile(flag('event-schema')),
    readFile(flag('operations'), 'utf8').then(
      (bytes) => operationsSchema.parse(JSON.parse(bytes)) as SefazOperationMap,
    ),
  ])
  const s3 = new S3Client({
    region,
    forcePathStyle: Boolean(endpoint),
    ...(endpoint ? { endpoint } : {}),
  })
  const artifacts = new FiscalArtifacts(
    databaseUrl,
    new EncryptedFiscalArtifactStore(new S3ObjectStore(s3, bucket), key),
  )
  const ledger = new HomologationExchangeLedger(databaseUrl, artifacts)
  const capabilities = new FiscalCapabilities(databaseUrl)
  const adapter = new SefazNfe55HomologationAdapter(credential, operations)
  const cancellation = new HomologationCancellation(
    ledger,
    capabilities,
    adapter,
    credential,
    schemaZip,
  )
  try {
    const result = await cancellation.prepare({
      tenantId,
      documentId,
      exchangeId,
      actorId,
      reason,
      occurredAt,
    })
    process.stdout.write(`${JSON.stringify({ ...result, sent: false }, null, 2)}\n`)
  } finally {
    await Promise.all([ledger.close(), capabilities.close(), artifacts.close()])
    s3.destroy()
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phase 43 cancellation preparation failed')
  process.exitCode = 1
})
