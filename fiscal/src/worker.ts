import './telemetry'
import { S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { createFiscalServer } from './api'
import { EncryptedFiscalArtifactStore, S3ObjectStore } from './artifact-store'
import { FiscalArtifacts } from './artifacts'
import { FiscalTokenVerifier, RedisDenylist } from './auth'
import { HttpOwnerFiscalClient } from './backfill'
import { FiscalCalculations } from './calculations'
import { FiscalConsumer } from './consumer'
import { FiscalDocuments } from './documents'
import { FiscalIngress } from './ingress'
import { FiscalProjections } from './projections'
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
const server = createFiscalServer({
  verifier,
  documents,
  artifacts,
  calculations,
  rules: ruleStore,
})
const keys = z
  .record(z.uuid(), z.string().min(20))
  .parse(JSON.parse(config.FISCAL_SERVICE_KEYS_JSON))
const tokens = new FiscalServiceTokens(config.IDENTITY_URL, keys)
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
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await consumer.close()
  await Promise.all([
    ingress.close(),
    projections.close(),
    documents.close(),
    artifacts.close(),
    calculations.close(),
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
      ruleStore.close(),
      denylist.close(),
    ])
    s3.destroy()
    await stopTelemetry()
    process.exitCode = 1
  })
