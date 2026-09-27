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
import { FiscalCorrectionLetters } from './correction-letters'
import { FiscalDispatch } from './dispatch'
import { FiscalDocumentLinksReader } from './document-links'
import { FiscalDocumentList } from './document-list'
import { FiscalDocuments } from './documents'
import { FiscalEstablishmentCredentials } from './establishment-credentials'
import { FiscalInboundImports } from './inbound-imports'
import { FiscalInboundReconciliations } from './inbound-reconciliations'
import { FiscalIngress } from './ingress'
import { FiscalIssuance } from './issuance'
import { FiscalIssueWorker } from './issue-worker'
import { FiscalLinkedOrigins } from './linked-origins'
import { FiscalManualOrigins } from './manual-origins'
import { startSupportGauges } from './metrics'
import { DeterministicNfce65Simulator } from './nfce65/simulator'
import { nfe55IssuanceProfileSchema } from './nfe55/issuance-profile'
import { DeterministicNfe55Simulator } from './nfe55/simulator'
import { createServiceRuntime } from './nfse/runtime'
import { FiscalOutboxRelay } from './outbox'
import { loadPhase43WorkerRuntime } from './phase43-worker-runtime'
import { FiscalProjections } from './projections'
import { FiscalReadiness } from './readiness'
import { FiscalRuleStore } from './rule-store'
import { FiscalServiceTokens } from './service-tokens'
import { FiscalSupport } from './support'
import { stopTelemetry } from './telemetry'

const optionalSetting = (schema: z.ZodString) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional())

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
    FISCAL_SIMULATION_PROFILE_JSON: optionalSetting(z.string().min(2)),
    FISCAL_SIMULATION_PRIVATE_KEY_PATH: optionalSetting(z.string().min(1)),
    FISCAL_SIMULATION_CERTIFICATE_PATH: optionalSetting(z.string().min(1)),
    FISCAL_PHASE42_SCHEMA_PATH: optionalSetting(z.string().min(1)),
    FISCAL_PHASE42_EVENT_SCHEMA_PATH: optionalSetting(z.string().min(1)),
    FISCAL_SIMULATOR_SCENARIO: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .enum([
          'authorized',
          'rejected',
          'timeout-before-accept',
          'timeout-after-accept',
          'delayed-consultation',
        ])
        .optional(),
    ),
    FISCAL_SIMULATOR_RETRY_DELAY_MS: z.coerce.number().int().min(0).max(300_000).default(1_000),
    FISCAL_PHASE43_WORKER_CONFIG_PATH: optionalSetting(z.string().min(1)),
    FISCAL_INBOUND_SCHEMA_PATH: optionalSetting(z.string().min(1)),
    FISCAL_NFSE_SCHEMA_PATH: optionalSetting(z.string().min(1)),
  })
  .parse(process.env)

const ingress = new FiscalIngress(
  config.DATABASE_URL,
  Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
)
const projections = new FiscalProjections(
  config.DATABASE_URL,
  Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
)
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
const urls = {
  parties: config.PARTIES_URL,
  identity: config.IDENTITY_URL,
  catalog: config.CATALOG_URL,
}
const manualOrigins = new FiscalManualOrigins(
  config.DATABASE_URL,
  Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
  projections,
  capabilities,
  (tenantId) => new HttpOwnerFiscalClient(urls, () => tokens.forTenant(tenantId)),
)
const dispatch = new FiscalDispatch(config.DATABASE_URL)
const credentials = new FiscalEstablishmentCredentials(
  config.DATABASE_URL,
  Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
)
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
if (config.FISCAL_SIMULATOR_SCENARIO && !issuance)
  throw new Error('A fixed Fiscal simulator scenario requires the complete issuance configuration')
// The reviewed NFC-e facts travel in the same issuance profile (Phase 46).
const consumerProfile = issuance
  ? nfe55IssuanceProfileSchema.parse(JSON.parse(config.FISCAL_SIMULATION_PROFILE_JSON as string))
      .consumer
  : undefined
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
      consumerProfile
        ? { cancellationWindowMinutes: consumerProfile.cancellationWindowMinutes }
        : undefined,
    )
  : undefined
// PL 010f is the same pinned package the Phase 42 issuance validates against.
const inboundSchemaDigest = 'b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998'
const inboundImports = config.FISCAL_INBOUND_SCHEMA_PATH
  ? new FiscalInboundImports(
      config.DATABASE_URL,
      Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
      artifactStore,
      projections,
      { zip: readFileSync(config.FISCAL_INBOUND_SCHEMA_PATH), digest: inboundSchemaDigest },
    )
  : undefined
const inboundReconciliations = inboundImports
  ? new FiscalInboundReconciliations(
      config.DATABASE_URL,
      Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
      projections,
    )
  : undefined
const linkedOrigins = new FiscalLinkedOrigins(
  config.DATABASE_URL,
  Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
  documents,
  (tenantId) => new HttpOwnerFiscalClient(urls, () => tokens.forTenant(tenantId)),
)
const documentLinks = new FiscalDocumentLinksReader(config.DATABASE_URL)
// The correction letter is signed with the same simulation credential and validated with
// the same PL 010d envelope as the cancellation event.
const correctionLetters = config.FISCAL_PHASE42_EVENT_SCHEMA_PATH
  ? new FiscalCorrectionLetters(
      config.DATABASE_URL,
      documents,
      artifacts,
      {
        privateKey: readFileSync(config.FISCAL_SIMULATION_PRIVATE_KEY_PATH as string),
        certificate: readFileSync(config.FISCAL_SIMULATION_CERTIFICATE_PATH as string),
      },
      readFileSync(config.FISCAL_PHASE42_EVENT_SCHEMA_PATH),
      '45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b',
    )
  : undefined
// The reviewed national NFS-e facts travel in the same issuance profile (Phase 47).
const fullProfile = issuance
  ? nfe55IssuanceProfileSchema.parse(JSON.parse(config.FISCAL_SIMULATION_PROFILE_JSON as string))
  : undefined
if (config.FISCAL_NFSE_SCHEMA_PATH && !fullProfile?.service)
  throw new Error('The NFS-e schema path requires the issuance profile service block')
const serviceRuntime = createServiceRuntime({
  databaseUrl: config.DATABASE_URL,
  masterKey: Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
  projections,
  capabilities,
  calculations,
  documents,
  artifacts,
  dispatch,
  ownerForTenant: (tenantId) => new HttpOwnerFiscalClient(urls, () => tokens.forTenant(tenantId)),
  ...(fullProfile && config.FISCAL_NFSE_SCHEMA_PATH
    ? {
        issuance: {
          profile: fullProfile,
          credential: {
            privateKey: readFileSync(config.FISCAL_SIMULATION_PRIVATE_KEY_PATH as string),
            certificate: readFileSync(config.FISCAL_SIMULATION_CERTIFICATE_PATH as string),
          },
          schemaZip: readFileSync(config.FISCAL_NFSE_SCHEMA_PATH),
          ...(config.FISCAL_SIMULATOR_SCENARIO
            ? { scenario: config.FISCAL_SIMULATOR_SCENARIO }
            : {}),
          retryDelayMilliseconds: config.FISCAL_SIMULATOR_RETRY_DELAY_MS,
        },
      }
    : {}),
})
const documentList = new FiscalDocumentList(config.DATABASE_URL)
const support = new FiscalSupport(config.DATABASE_URL)
// Gauges sum the tenants this worker serves; no metric names a tenant (ADR 0055).
const stopSupportGauges = startSupportGauges(support, Object.keys(keys))
const server = createFiscalServer({
  verifier,
  documents,
  manualOrigins,
  dispatch,
  artifacts,
  calculations,
  capabilities,
  readiness,
  ...(issuance ? { issuance } : {}),
  ...(cancellation ? { cancellation } : {}),
  rules: ruleStore,
  credentials,
  ...(inboundImports && inboundReconciliations
    ? { inbound: { imports: inboundImports, reconciliations: inboundReconciliations } }
    : {}),
  linked: {
    origins: linkedOrigins,
    links: documentLinks,
    ...(correctionLetters ? { correctionLetters } : {}),
  },
  service: serviceRuntime.dependencies,
  documentList,
  support,
})
const fixedSimulatorScenario = config.FISCAL_SIMULATOR_SCENARIO
const simulator = new DeterministicNfe55Simulator(
  fixedSimulatorScenario ? () => fixedSimulatorScenario : undefined,
)
const issueWorker = new FiscalIssueWorker(
  dispatch,
  artifacts,
  simulator,
  config.FISCAL_SIMULATOR_RETRY_DELAY_MS,
  new DeterministicNfce65Simulator(
    fixedSimulatorScenario ? () => fixedSimulatorScenario : undefined,
  ),
  serviceRuntime.processor,
)
const outbox = new FiscalOutboxRelay(config.DATABASE_URL, config.RABBITMQ_URL)
let phase43Runtime: Awaited<ReturnType<typeof loadPhase43WorkerRuntime>> | null = null
let issueWorkerBusy = false
const issueWorkerTimer = setInterval(() => {
  if (issueWorkerBusy) return
  issueWorkerBusy = true
  void Promise.all(
    Object.keys(keys).map(async (tenantId) => {
      await issueWorker.processOne(tenantId, 'fiscal:issue-worker')
      await correctionLetters?.processOne(
        tenantId,
        'fiscal:correction-worker',
        simulator,
        config.FISCAL_SIMULATOR_RETRY_DELAY_MS,
      )
      await phase43Runtime?.worker.processOne(tenantId, 'fiscal:phase43-worker')
      // Services delivered in Sales, a few per cycle so one tenant never starves the rest.
      for (let step = 0; step < 5; step += 1)
        if (!(await serviceRuntime.intakes.processOne(tenantId))) break
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
const consumer = new FiscalConsumer(
  config.RABBITMQ_URL,
  ingress,
  projections,
  (tenantId) => new HttpOwnerFiscalClient(urls, () => tokens.forTenant(tenantId)),
)

async function stop(): Promise<void> {
  clearInterval(issueWorkerTimer)
  stopSupportGauges()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await consumer.close()
  await Promise.all([
    ingress.close(),
    projections.close(),
    documents.close(),
    manualOrigins.close(),
    artifacts.close(),
    calculations.close(),
    capabilities.close(),
    dispatch.close(),
    issuance?.close(),
    cancellation?.close(),
    outbox.close(),
    ruleStore.close(),
    credentials.close(),
    inboundImports?.close(),
    inboundReconciliations?.close(),
    linkedOrigins.close(),
    documentLinks.close(),
    correctionLetters?.close(),
    serviceRuntime.close(),
    documentList.close(),
    support.close(),
    denylist.close(),
    phase43Runtime?.close(),
  ])
  s3.destroy()
  await stopTelemetry()
}

process.once('SIGTERM', () => void stop().then(() => process.exit(0)))
process.once('SIGINT', () => void stop().then(() => process.exit(0)))

void consumer
  .start()
  .then(async () => {
    if (config.FISCAL_PHASE43_WORKER_CONFIG_PATH)
      phase43Runtime = await loadPhase43WorkerRuntime(
        config.DATABASE_URL,
        artifacts,
        config.FISCAL_PHASE43_WORKER_CONFIG_PATH,
        Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
      )
    await new Promise<void>((resolve) => server.listen(config.PORT, '0.0.0.0', resolve))
  })
  .catch(async (error: unknown) => {
    console.error('Fiscal consumer startup failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    })
    stopSupportGauges()
    await Promise.allSettled([
      ingress.close(),
      projections.close(),
      documents.close(),
      manualOrigins.close(),
      artifacts.close(),
      calculations.close(),
      capabilities.close(),
      dispatch.close(),
      issuance?.close(),
      cancellation?.close(),
      outbox.close(),
      ruleStore.close(),
      credentials.close(),
      serviceRuntime.close(),
      documentList.close(),
      support.close(),
      denylist.close(),
      phase43Runtime?.close(),
    ])
    s3.destroy()
    await stopTelemetry()
    process.exitCode = 1
  })
