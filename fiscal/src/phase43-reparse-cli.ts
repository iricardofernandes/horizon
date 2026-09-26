import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { EncryptedFiscalArtifactStore, S3ObjectStore } from './artifact-store'
import { FiscalArtifacts } from './artifacts'
import { HomologationExchangeLedger } from './homologation-exchange-ledger'
import { HomologationRawRecovery } from './homologation-raw-recovery'
import { SefazNfe55HomologationAdapter, type SefazOperationMap } from './nfe55/sefaz-adapter'
import { SefazResponseSchemaValidator } from './nfe55/sefaz-response-schema'
import { digestSchema, operationsSchema } from './phase43-runtime-input'

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`--${name} is required`)
  return value
}

async function source(path: string) {
  const archive = await readFile(path)
  return { archive, digest: createHash('sha256').update(archive).digest('hex') }
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
  const exchangeId = z.uuid().parse(flag('exchange'))
  const actorId = z.string().min(1).max(200).parse(flag('actor'))
  const [operations, documentSchemas, consultationSchemas] = await Promise.all([
    readFile(flag('operations'), 'utf8').then(
      (bytes) => operationsSchema.parse(JSON.parse(bytes)) as SefazOperationMap,
    ),
    source(flag('document-response-schema')),
    source(flag('consultation-response-schema')),
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
  const scope = await ledger.exchangeScope(tenantId, exchangeId)
  const parser = new SefazNfe55HomologationAdapter(
    { certificate: Buffer.alloc(0), issuerTaxId: '00000000000000' },
    operations,
    scope.jurisdiction,
  )
  const recovery = new HomologationRawRecovery(
    ledger,
    parser,
    new SefazResponseSchemaValidator(documentSchemas, consultationSchemas),
  )
  try {
    const response = await recovery.reparse(tenantId, exchangeId, actorId, operations)
    process.stdout.write(
      `${JSON.stringify(
        {
          exchangeId,
          service: response.service,
          statusCode: response.statusCode,
          documentStatusCode: response.documentStatusCode,
          eventStatusCode: response.eventStatusCode,
          receipt: response.receipt,
          protocolNumber: response.protocolNumber,
          responseDigest: createHash('sha256').update(response.response).digest('hex'),
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    await Promise.all([ledger.close(), artifacts.close()])
    s3.destroy()
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phase 43 raw response recovery failed')
  process.exitCode = 1
})
