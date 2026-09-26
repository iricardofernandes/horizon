import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { EncryptedFiscalArtifactStore, S3ObjectStore } from './artifact-store'
import { FiscalArtifacts } from './artifacts'
import { FiscalCalculations } from './calculations'
import { FiscalCapabilities } from './capabilities'
import { FiscalDocuments } from './documents'
import { FiscalEstablishmentCredentials } from './establishment-credentials'
import { HomologationExchangeLedger } from './homologation-exchange-ledger'
import { HomologationIssuance } from './homologation-issuance'
import { SefazNfe55HomologationAdapter, type SefazOperationMap } from './nfe55/sefaz-adapter'
import { digestSchema, operationsSchema } from './phase43-runtime-input'
import { FiscalProjections } from './projections'
import { FiscalRuleStore } from './rule-store'

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
  const drillGrantId = z.uuid().parse(flag('grant'))
  const exchangeId = z.uuid().parse(flag('exchange'))
  const actorId = z.string().min(1).max(200).parse(flag('actor'))
  const credentials = new FiscalEstablishmentCredentials(databaseUrl, key)
  const certificate = await credentials.forDocument(tenantId, documentId)
  const schemaZip = await readFile(flag('schema'))
  const schemaDigest = createHash('sha256').update(schemaZip).digest('hex')
  const operations: SefazOperationMap = operationsSchema.parse(
    JSON.parse(await readFile(flag('operations'), 'utf8')),
  )
  const documents = new FiscalDocuments(databaseUrl, key)
  const projections = new FiscalProjections(databaseUrl)
  const rules = new FiscalRuleStore(databaseUrl)
  const calculations = new FiscalCalculations(databaseUrl, key, rules)
  const capabilities = new FiscalCapabilities(databaseUrl)
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
  const scope = await ledger.drillScope(tenantId, documentId, drillGrantId)
  const adapter = new SefazNfe55HomologationAdapter(certificate, operations, scope.jurisdiction)
  const issuance = new HomologationIssuance(
    databaseUrl,
    documents,
    projections,
    calculations,
    capabilities,
    ledger,
    adapter,
    certificate,
    schemaZip,
    schemaDigest,
  )
  try {
    const result = await issuance.prepare({
      tenantId,
      documentId,
      drillGrantId,
      exchangeId,
      actorId,
    })
    process.stdout.write(
      `${JSON.stringify(
        {
          exchangeId: result.exchangeId,
          accessKey: result.accessKey,
          number: result.number,
          signedXmlDigest: result.signedXmlDigest,
          requestDigest: result.requestDigest,
          sent: false,
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    await Promise.all([
      issuance.close(),
      ledger.close(),
      artifacts.close(),
      capabilities.close(),
      calculations.close(),
      rules.close(),
      projections.close(),
      documents.close(),
      credentials.close(),
      s3.destroy(),
    ])
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phase 43 issuance preparation failed')
  process.exitCode = 1
})
