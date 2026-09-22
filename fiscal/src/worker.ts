import './telemetry'
import { readFileSync } from 'node:fs'
import { S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { createFiscalServer } from './api'
import { EncryptedFiscalArtifactStore, S3ObjectStore } from './artifact-store'
import { FiscalArtifacts } from './artifacts'
import { FiscalTokenVerifier, RedisDenylist } from './auth'
import { HttpOwnerFiscalClient } from './backfill'
import { FiscalCalculations } from './calculations'
import { FiscalCancellation } from './cancellation'
import { FiscalCapabilities } from './capabilities'
import { FiscalConsumer } from './consumer'
import { FiscalDispatch } from './dispatch'
import { FiscalDocuments } from './documents'
import { FiscalIngress } from './ingress'
import { FiscalIssuance } from './issuance'
import { FiscalIssueWorker } from './issue-worker'
import { DeterministicNfe55Simulator } from './nfe55/simulator'
import { FiscalOutboxRelay } from './outbox'
import { FiscalProjections } from './projections'
import { FiscalReadiness } from './readiness'
import { FiscalRuleStore } from './rule-store'
import { FiscalServiceTokens } from './service-tokens'
import { stopTelemetry } from './telemetry'

const config = z
  .object({
    DATABASE_URL: z.url(),
    RABBITMQ_URL: z.url(),
    PARTIES_URL: z.url(),
    IDENTITY_URL: z.url(),
    CATALOG_URL: z.url(),
    FISCAL_SERVICE_KEYS_JSON: z.string().min(2).max(100_000),
    REDIS_URL: z.url(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3011),
    FISCAL_ARTIFACT_BUCKET: z.string().min(3),
    FISCAL_ARTIFACT_REGION: z.string().min(1),
    FISCAL_ARTIFACT_ENDPOINT: z.url().optional(),
    FISCAL_ARTIFACT_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/i),
    FISCAL_SIMULATION_PROFILE_JSON: z.string().min(2).optional(),
    FISCAL_SIMULATION_PRIVATE_KEY_PATH: z.string().min(1).optional(),
    FISCAL_SIMULATION_CERTIFICATE_PATH: z.string().min(1).optional(),
    FISCAL_PHASE42_SCHEMA_PATH: z.string().min(1).optional(),
    FISCAL_PHASE42_EVENT_SCHEMA_PATH: z.string().min(1).optional(),
  })
  .parse(process.env)

const ingress = new FiscalIngress(
  config.DATABASE_URL,
  Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
)
const projections = new FiscalProjections(config.DATABASE_URL)
const documents = new FiscalDocuments(
  config.DATABASE_URL,
  Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
)
const ruleStore = new FiscalRuleStore(config.DATABASE_URL)
const calculations = new FiscalCalculations(
  config.DATABASE_URL,
  Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
  ruleStore,
)
const capabilities = new FiscalCapabilities(config.DATABASE_URL)
const readiness = new FiscalReadiness(documents, projections, capabilities, calculations)
const s3 = new S3Client({
  region: config.FISCAL_ARTIFACT_REGION,
  forcePathStyle: Boolean(config.FISCAL_ARTIFACT_ENDPOINT),
  ...(config.FISCAL_ARTIFACT_ENDPOINT ? { endpoint: config.FISCAL_ARTIFACT_ENDPOINT } : {}),
})
const artifactStore = new EncryptedFiscalArtifactStore(
  new S3ObjectStore(s3, config.FISCAL_ARTIFACT_BUCKET),
  Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
)
const artifacts = new FiscalArtifacts(config.DATABASE_URL, artifactStore)
const denylist = new RedisDenylist(config.REDIS_URL)
const verifier = new FiscalTokenVerifier(`${config.IDENTITY_URL}/.well-known/jwks.json`, denylist)
const keys = z
  .record(z.uuid(), z.string().min(20))
  .parse(JSON.parse(config.FISCAL_SERVICE_KEYS_JSON))
const tokens = new FiscalServiceTokens(config.IDENTITY_URL, keys)
const dispatch = new FiscalDispatch(config.DATABASE_URL)
const issuanceConfiguration = [
  config.FISCAL_SIMULATION_PROFILE_JSON,
  config.FISCAL_SIMULATION_PRIVATE_KEY_PATH,
  config.FISCAL_SIMULATION_CERTIFICATE_PATH,
  config.FISCAL_PHASE42_SCHEMA_PATH,
]
if (issuanceConfiguration.some(Boolean) && !issuanceConfiguration.every(Boolean))
  throw new Error('Phase 42 issuance configuration must be supplied as one complete set')
const issuance = issuanceConfiguration.every(Boolean)
  ? new FiscalIssuance(
      config.DATABASE_URL,
      documents,
      projections,
      calculations,
      artifacts,
      dispatch,
      JSON.parse(config.FISCAL_SIMULATION_PROFILE_JSON as string),
      {
        privateKey: readFileSync(config.FISCAL_SIMULATION_PRIVATE_KEY_PATH as string),
        certificate: readFileSync(config.FISCAL_SIMULATION_CERTIFICATE_PATH as string),
      },
      readFileSync(config.FISCAL_PHASE42_SCHEMA_PATH as string),
      'b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998',
    )
  : undefined
if (config.FISCAL_PHASE42_EVENT_SCHEMA_PATH && !issuance)
  throw new Error('Phase 42 cancellation requires the complete issuance configuration')
const cancellation = config.FISCAL_PHASE42_EVENT_SCHEMA_PATH
  ? new FiscalCancellation(
      config.DATABASE_URL,
      documents,
      artifacts,
      dispatch,
      {
        privateKey: readFileSync(config.FISCAL_SIMULATION_PRIVATE_KEY_PATH as string),
        certificate: readFileSync(config.FISCAL_SIMULATION_CERTIFICATE_PATH as string),
      },
      readFileSync(config.FISCAL_PHASE42_EVENT_SCHEMA_PATH),
      '45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b',
    )
  : undefined
const server = createFiscalServer({
  verifier,
  documents,
  dispatch,
  artifacts,
  calculations,
  capabilities,
  readiness,
  ...(issuance ? { issuance } : {}),
  ...(cancellation ? { cancellation } : {}),
  rules: ruleStore,
})
const issueWorker = new FiscalIssueWorker(dispatch, artifacts, new DeterministicNfe55Simulator())
const outbox = new FiscalOutboxRelay(config.DATABASE_URL, config.RABBITMQ_URL)
let issueWorkerBusy = false
const issueWorkerTimer = setInterval(() => {
  if (issueWorkerBusy) return
  issueWorkerBusy = true
  void Promise.all(
    Object.keys(keys).map(async (tenantId) => {
      await issueWorker.processOne(tenantId, 'fiscal:issue-worker')
      await outbox.flush(tenantId)
    }),
  )
    .catch((error: unknown) =>
      console.error('Fiscal issue worker cycle failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    )
    .finally(() => {
      issueWorkerBusy = false
    })
}, 1_000)
issueWorkerTimer.unref()
const urls = {
  parties: config.PARTIES_URL,
  identity: config.IDENTITY_URL,
  catalog: config.CATALOG_URL,
}
const consumer = new FiscalConsumer(
  config.RABBITMQ_URL,
  ingress,
  projections,
  (tenantId) => new HttpOwnerFiscalClient(urls, () => tokens.forTenant(tenantId)),
)

async function stop(): Promise<void> {
  clearInterval(issueWorkerTimer)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await consumer.close()
  await Promise.all([
    ingress.close(),
    projections.close(),
    documents.close(),
    artifacts.close(),
    calculations.close(),
    capabilities.close(),
    dispatch.close(),
    issuance?.close(),
    cancellation?.close(),
    outbox.close(),
    ruleStore.close(),
    denylist.close(),
  ])
  s3.destroy()
  await stopTelemetry()
}

process.once('SIGTERM', () => void stop().then(() => process.exit(0)))
process.once('SIGINT', () => void stop().then(() => process.exit(0)))

void consumer
  .start()
  .then(async () => {
    await new Promise<void>((resolve) => server.listen(config.PORT, '0.0.0.0', resolve))
  })
  .catch(async (error: unknown) => {
    console.error('Fiscal consumer startup failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    })
    await Promise.allSettled([
      ingress.close(),
      projections.close(),
      documents.close(),
      artifacts.close(),
      calculations.close(),
      capabilities.close(),
      dispatch.close(),
      issuance?.close(),
      cancellation?.close(),
      outbox.close(),
      ruleStore.close(),
      denylist.close(),
    ])
    s3.destroy()
    await stopTelemetry()
    process.exitCode = 1
  })
