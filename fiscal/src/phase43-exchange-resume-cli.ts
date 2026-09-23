import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { EncryptedFiscalArtifactStore, S3ObjectStore } from './artifact-store'
import { FiscalArtifacts } from './artifacts'
import { HomologationExchangeLedger } from './homologation-exchange-ledger'
import { HomologationExchangeRunner } from './homologation-exchange-runner'
import { HomologationRecovery } from './homologation-recovery'
import { loadHomologationCredential } from './nfe55/homologation-credential'
import { SefazNfe55HomologationAdapter, type SefazOperationMap } from './nfe55/sefaz-adapter'
import { SefazResponseSchemaValidator } from './nfe55/sefaz-response-schema'
import type { SefazResponse } from './nfe55/sefaz-soap'
import { SefazHomologationTransport } from './nfe55/sefaz-transport'
import { loadSefazTrustAnchor } from './nfe55/sefaz-trust-anchor'
import { digestSchema, endpointsSchema, operationsSchema } from './phase43-runtime-input'

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`--${name} is required`)
  return value
}

async function schemaSource(path: string) {
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
  const workerId = z.string().min(1).max(200).parse(flag('worker'))
  const actionIndex = process.argv.indexOf('--action')
  const action = actionIndex < 0 ? 'resume' : process.argv[actionIndex + 1]
  if (action !== 'resume' && action !== 'consult' && action !== 'status')
    throw new Error('--action must be resume, consult, or status')
  const documentId =
    action === 'consult' || action === 'status' ? z.uuid().parse(flag('document')) : null
  const drillGrantId = action === 'status' ? z.uuid().parse(flag('grant')) : null
  const [credential, trustAnchor, operations, endpoints, documentSchemas, consultationSchemas] =
    await Promise.all([
      loadHomologationCredential({
        certificatePath: flag('certificate'),
        privateKeyPath: flag('private-key'),
        expectedFingerprint: flag('certificate-fingerprint'),
        expectedIssuerTaxId: flag('issuer-tax-id'),
      }),
      loadSefazTrustAnchor({
        certificatePath: flag('trust-anchor'),
        expectedFingerprint: flag('trust-anchor-fingerprint'),
      }),
      readFile(flag('operations'), 'utf8').then(
        (bytes) => operationsSchema.parse(JSON.parse(bytes)) as SefazOperationMap,
      ),
      readFile(flag('endpoints'), 'utf8').then((bytes) => endpointsSchema.parse(JSON.parse(bytes))),
      schemaSource(flag('document-response-schema')),
      schemaSource(flag('consultation-response-schema')),
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
  const adapter = new SefazNfe55HomologationAdapter(credential, operations)
  const transport = new SefazHomologationTransport(endpoints, credential, trustAnchor)
  const responseSchemas = new SefazResponseSchemaValidator(documentSchemas, consultationSchemas)
  const runner = new HomologationExchangeRunner(ledger, transport, adapter, responseSchemas)
  try {
    let response: SefazResponse
    if (documentId && drillGrantId) {
      const context = await ledger.drillContext(tenantId, documentId, drillGrantId)
      const prepared = await adapter.prepare({ service: 'status' })
      response = await runner.execute(
        {
          tenantId,
          documentId,
          exchangeId,
          parentExchangeId: null,
          actorId,
          workerId,
          ...context,
        },
        prepared,
      )
    } else if (documentId) {
      const target = await ledger.recoveryTarget(tenantId, documentId)
      const parent = await ledger.loadPrepared(
        tenantId,
        target.parentExchangeId,
        operations,
        actorId,
      )
      if (parent.input.documentId !== documentId || parent.prepared.service !== 'authorization')
        throw new Error('SEFAZ recovery parent differs from authorization')
      const recovery = new HomologationRecovery(ledger, adapter, runner)
      response = await recovery.consult({
        ...parent.input,
        documentId,
        exchangeId,
        actorId,
        workerId,
      })
    } else {
      response = await runner.resume({ tenantId, exchangeId, actorId, workerId }, operations)
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          exchangeId,
          action,
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
  console.error(error instanceof Error ? error.message : 'Phase 43 exchange resume failed')
  process.exitCode = 1
})
