import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fiscalServiceDocumentOutcome } from '@horizon/contracts'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EncryptedFiscalArtifactStore, LocalObjectStore } from '../src/artifact-store'
import { FiscalArtifacts } from '../src/artifacts'
import { type AuditRow, verifyAuditRows } from '../src/audit'
import { FiscalCalculations } from '../src/calculations'
import { FiscalCapabilities } from '../src/capabilities'
import { FiscalDispatch } from '../src/dispatch'
import { FiscalDocumentList } from '../src/document-list'
import { FiscalDocuments } from '../src/documents'
import { FiscalIngress } from '../src/ingress'
import { FiscalIssueWorker } from '../src/issue-worker'
import type { SimulationCredential } from '../src/nfe55/signature'
import { DeterministicNfe55Simulator, type SimulatorScenario } from '../src/nfe55/simulator'
import { FiscalServiceCancellation } from '../src/nfse/cancellation'
import { FiscalServiceDocuments } from '../src/nfse/documents'
import {
  MunicipalityUnsupported,
  ServiceCancellationWindowElapsed,
  ServiceProfileMissing,
  SourceKeyConflict,
  SubstitutionNotAllowed,
} from '../src/nfse/errors'
import { FiscalServiceIntakes } from '../src/nfse/intake'
import { FiscalServiceIssuance, type ServiceProfile } from '../src/nfse/issuance'
import { FiscalServiceIssuancePolicies } from '../src/nfse/issuance-policies'
import { NfseDispatchProcessor, NfseProcessingFacts } from '../src/nfse/processor'
import { FiscalServiceReadiness } from '../src/nfse/readiness'
import { FiscalNfseRegistry } from '../src/nfse/registry'
import { validateNfseSchema } from '../src/nfse/schema'
import { FiscalServiceOrigins } from '../src/nfse/service-origins'
import { FiscalServiceProfiles } from '../src/nfse/service-profiles'
import { DeterministicNfseSimulator } from '../src/nfse/simulator'
import { FiscalServiceSubstitutions } from '../src/nfse/substitution'
import {
  approvedPhase47IbsCbsSource,
  approvedPhase47IssSource,
  PHASE47_ADAPTER,
  PHASE47_FIXTURE,
  PHASE47_IBS_CBS_RATES,
  PHASE47_MUNICIPAL_PARAMETERS,
  phase47RegistryVersion,
} from '../src/phase47-approved-scenario'
import { FiscalProjections } from '../src/projections'
import { FiscalRuleStore } from '../src/rule-store'
import { FiscalSupport } from '../src/support'

const run = promisify(execFile)
const SAO_PAULO = '3550308'
const CAMPINAS = '3509502'
const ISSUER_CNPJ = '98765432000198'
const CANCELLATION_DAYS = 30
const SUBSTITUTION_DAYS = 30

let container: StartedPostgreSqlContainer
let url: string
let directory: string
let masterKey: Buffer
let credential: SimulationCredential
let schemaZip: Buffer
let projections: FiscalProjections
let store: FiscalRuleStore
let calculations: FiscalCalculations
let capabilities: FiscalCapabilities
let documents: FiscalDocuments
let dispatch: FiscalDispatch
let artifacts: FiscalArtifacts
let registry: FiscalNfseRegistry
let profiles: FiscalServiceProfiles
let origins: FiscalServiceOrigins
let serviceDocuments: FiscalServiceDocuments
let readiness: FiscalServiceReadiness
let documentList: FiscalDocumentList
let support: FiscalSupport
let ingress: FiscalIngress
let policies: FiscalServiceIssuancePolicies
const services: Array<{ close(): Promise<void> }> = []
const catalogServices = new Set<string>()

type Tenant = {
  tenantId: string
  establishmentId: string
  recipientId: string
  serviceItemId: string
  profileRevision: number
  capabilityId: string
  profile: ServiceProfile
  issuance: FiscalServiceIssuance
  cancellation: FiscalServiceCancellation
  substitutions: FiscalServiceSubstitutions
  facts: NfseProcessingFacts
  calls: { submit: number; consult: number }
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('horizon_phase47_nfse_test')
    .withUsername('postgres')
    .withPassword('test')
    .start()
  const admin = postgres(container.getConnectionUri(), { max: 1 })
  await admin.unsafe(
    `CREATE ROLE horizon_owner LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_app LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     REVOKE ALL ON SCHEMA public FROM PUBLIC;
     GRANT USAGE ON SCHEMA public TO horizon_app;
     GRANT USAGE, CREATE ON SCHEMA public TO horizon_owner;`,
    [],
    { prepare: false },
  )
  await admin.end()
  await run(process.execPath, ['scripts/migrate.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_MIGRATION_URL: container
        .getConnectionUri()
        .replace('postgres:test@', 'horizon_owner:test@'),
    },
  })
  url = container.getConnectionUri().replace('postgres:test@', 'horizon_app:test@')
  directory = await mkdtemp(join(tmpdir(), 'horizon-phase47-'))
  masterKey = randomBytes(32)
  credential = await selfSigned(directory)
  schemaZip = await readFile(
    new URL('../fixtures/official/nfse-xsd-v1.01-20260209.zip', import.meta.url),
  )
  projections = new FiscalProjections(url, masterKey)
  store = new FiscalRuleStore(url)
  calculations = new FiscalCalculations(url, masterKey, store)
  capabilities = new FiscalCapabilities(url)
  documents = new FiscalDocuments(url, masterKey)
  dispatch = new FiscalDispatch(url)
  artifacts = new FiscalArtifacts(
    url,
    new EncryptedFiscalArtifactStore(new LocalObjectStore(join(directory, 'objects')), masterKey),
  )
  registry = new FiscalNfseRegistry(url)
  const owner = () => ({
    async catalogItem(id: string) {
      return catalogServices.has(id)
        ? { id, kind: 'service', name: 'Desenvolvimento de sistemas', active: true }
        : { id, kind: 'product', name: 'Café', active: true }
    },
  })
  profiles = new FiscalServiceProfiles(url, owner)
  origins = new FiscalServiceOrigins(
    url,
    masterKey,
    projections,
    capabilities,
    profiles,
    registry,
    owner,
  )
  serviceDocuments = new FiscalServiceDocuments(url, masterKey, origins)
  readiness = new FiscalServiceReadiness(
    documents,
    projections,
    capabilities,
    profiles,
    registry,
    calculations,
  )
  services.push(
    projections,
    store,
    calculations,
    capabilities,
    documents,
    dispatch,
    artifacts,
    registry,
    profiles,
    origins,
    serviceDocuments,
  )
  documentList = new FiscalDocumentList(url)
  support = new FiscalSupport(url)
  ingress = new FiscalIngress(url, masterKey)
  policies = new FiscalServiceIssuancePolicies(url)
  services.push(documentList, support, ingress, policies)
}, 180_000)

afterAll(async () => {
  await Promise.allSettled(services.map((service) => service.close()))
  await container?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('Phase 47 national NFS-e', () => {
  it('issues an NFS-e for a reviewed service with its DPS, key and explained taxes', async () => {
    const tenant = await seedTenant()
    const origin = await serviceOrigin(tenant)
    const nfse = await authorizeNew(tenant, origin.id)
    expect(nfse).toMatchObject({
      model: 'nfse',
      status: 'authorized',
      municipalityCode: SAO_PAULO,
      competenceDate: '2026-09-01',
      number: 1,
      nfseNumber: '1',
      substitutesDocumentId: null,
    })
    expect(nfse.dpsId).toBe(`DPS${SAO_PAULO}2${ISSUER_CNPJ}00001000000000000001`)
    expect(nfse.nfseKey?.slice(0, 7)).toBe(SAO_PAULO)
    expect(nfse.nfseKey?.slice(9, 23)).toBe(ISSUER_CNPJ)

    const listed = await artifacts.list(tenant.tenantId, nfse.id)
    const nfseXml = listed?.artifacts.find((artifact) => artifact.kind === 'nfse_xml')
    const bytes = (
      await artifacts.get(tenant.tenantId, nfse.id, 'nfse_xml', String(nfseXml?.digest))
    ).bytes
    await validateNfseSchema({ xml: bytes, root: 'NFSe', schemaZip })
    const xml = bytes.toString()
    for (const fragment of [
      '<cTribNac>010101</cTribNac>',
      '<cNBS>115022000</cNBS>',
      '<dCompet>2026-09-01</dCompet>',
      '<pAliqAplic>2.00</pAliqAplic>',
      '<vISSQN>30.00</vISSQN>',
      '<vCBS>13.50</vCBS>',
      '<CNPJ>44555666000105</CNPJ>',
    ])
      expect(xml).toContain(fragment)
    expect(xml).not.toContain('<pAliq>')

    // Service tax and IBS/CBS sources are traceable in the locked calculation.
    const calculation = await calculations.readFrozen(tenant.tenantId, nfse.id)
    const components = calculation?.result.lines[0]?.components
    expect(
      components?.legacy.map((component) => [component.code, component.amount.amount]),
    ).toEqual([['ISS', '3000']])
    expect(components?.ibsCbs.map((component) => component.code).sort()).toEqual([
      'CBS',
      'IBS_MUN',
      'IBS_UF',
    ])
    expect(calculation?.input.competenceDate).toBe('2026-09-01')
    expect(components?.legacy[0]?.source.section).toContain('parametros_municipais/3550308')
    const [generation] = await scoped(
      tenant.tenantId,
      (tx) =>
        tx`select calculation_matches from fiscal_nfse_generations where document_id = ${nfse.id}`,
    )
    expect(generation?.calculation_matches).toBe(true)

    const events = await outbox(tenant)
    expect(events.every((row) => String(row.event_type).startsWith('fiscal.'))).toBe(true)
    const outcomes = events.filter((row) => row.event_type === fiscalServiceDocumentOutcome.type)
    expect(outcomes).toHaveLength(1)
    const payload = fiscalServiceDocumentOutcome.payload.parse(outcomes[0]?.payload)
    expect(payload).toMatchObject({
      documentId: nfse.id,
      outcome: 'authorized',
      municipalityCode: SAO_PAULO,
      competence: '2026-09',
      serviceOriginId: origin.id,
    })
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain(String(nfse.nfseKey))
    expect(serialized).not.toContain('44555666000105')
    // Generation records are immutable.
    const owner = postgres(container.getConnectionUri(), { max: 1 })
    await expect(
      owner`update fiscal_nfse_generations set nfse_number = '9' where document_id = ${nfse.id}`,
    ).rejects.toThrow(/append-only/)
    await owner.end()
    const audit = await scoped(
      tenant.tenantId,
      (tx) => tx<AuditRow[]>`select * from fiscal_audit_entries order by sequence`,
    )
    expect(verifyAuditRows(audit)).toBe(true)
  })

  it('maps one owner source key to one service origin and one live document', async () => {
    const tenant = await seedTenant()
    const sourceKey = {
      module: 'contracts',
      documentType: 'contract-period',
      id: randomUUID(),
      period: '2026-09',
    }
    const first = await serviceOrigin(tenant, { sourceKey })
    const again = await serviceOrigin(tenant, { sourceKey })
    expect(again).toMatchObject({ id: first.id, existing: true })
    await expect(serviceOrigin(tenant, { sourceKey, amount: '99900' })).rejects.toBeInstanceOf(
      SourceKeyConflict,
    )
    const draft = await createDraft(tenant, first.id)
    expect((await createDraft(tenant, first.id)).id).toBe(draft.id)
    const rows = await scoped(
      tenant.tenantId,
      (tx) => tx`select count(*)::int as count from fiscal_service_origins`,
    )
    expect(rows[0]?.count).toBe(1)
    const authorized = await authorize(tenant, draft.id)
    const event = fiscalServiceDocumentOutcome.payload.parse(
      (await outbox(tenant)).find((row) => row.event_type === fiscalServiceDocumentOutcome.type)
        ?.payload,
    )
    expect(event).toMatchObject({ documentId: authorized.id, sourceKey })
  })

  it('never lets an unsupported municipality reach the national system', async () => {
    const campinas = await seedTenant({ municipality: CAMPINAS })
    await expect(serviceOrigin(campinas)).rejects.toBeInstanceOf(MunicipalityUnsupported)
    expect((await registry.resolve(campinas.tenantId, CAMPINAS, '2026-09-01')).reason).toContain(
      'E0039',
    )
    expect((await registry.resolve(campinas.tenantId, '3304557', '2026-09-01')).route).toBe(
      'unsupported',
    )

    // São Paulo, until a later reviewed registry version withdraws the national issuer.
    const tenant = await seedTenant()
    const draft = await createDraft(tenant, (await serviceOrigin(tenant)).id)
    await validate(tenant, draft.id)
    const withdrawn = phase47RegistryVersion()
    const version = await registry.importVersion({
      tenantId: tenant.tenantId,
      actorId: 'reviewer:phase47-test',
      request: {
        ...withdrawn,
        publishedOn: '2026-09-25',
        sourceDigest: 'e'.repeat(64),
        entries: withdrawn.entries.map((entry) => ({ ...entry, nationalIssuer: false })),
      },
    })
    await registry.review({
      tenantId: tenant.tenantId,
      versionId: version.id,
      actorId: 'reviewer:phase47-test',
      interpretation: 'Test-only withdrawal of the national issuer.',
    })
    await expect(issue(tenant, draft.id)).rejects.toBeInstanceOf(MunicipalityUnsupported)
    await work(tenant, 'authorized')
    expect(tenant.calls).toEqual({ submit: 0, consult: 0 })
    expect((await documents.get(tenant.tenantId, draft.id))?.status).toBe('ready')

    // A later profile revision in force at the competence date stops the frozen one.
    const revised = await seedTenant()
    const pending = await createDraft(revised, (await serviceOrigin(revised)).id)
    await profiles.create({
      tenantId: revised.tenantId,
      actorId: 'reviewer:phase47-test',
      request: {
        itemId: revised.serviceItemId,
        nationalTaxCode: '010101',
        nbsCode: '115021000',
        issTaxation: '1',
        description: 'Desenvolvimento de programas não customizados',
        effectiveFrom: '2026-08-01',
        reason: 'Reclassificação revisada do serviço',
      },
    })
    await expect(
      readiness.validate({ tenantId: revised.tenantId, documentId: pending.id, actorId: 'user:a' }),
    ).rejects.toBeInstanceOf(ServiceProfileMissing)
  })

  it('reconciles a lost response by DPS identifier before any resend', async () => {
    const tenant = await seedTenant()
    const accepted = await createDraft(tenant, (await serviceOrigin(tenant)).id)
    await validate(tenant, accepted.id)
    await issue(tenant, accepted.id)
    await work(tenant, 'timeout-after-accept')
    expect((await documents.get(tenant.tenantId, accepted.id))?.status).toBe('unknown')
    await work(tenant, 'timeout-after-accept')
    const recovered = await serviceDocuments.get(tenant.tenantId, accepted.id)
    expect(recovered?.status).toBe('authorized')
    // One send, then one consultation: the generated DPS was never sent again (E0014).
    expect(tenant.calls).toEqual({ submit: 1, consult: 1 })
    expect(await observations(tenant, accepted.id)).toEqual([
      ['response', 'unknown'],
      ['consultation', 'authorized'],
    ])

    const lost = await createDraft(tenant, (await serviceOrigin(tenant)).id)
    await validate(tenant, lost.id)
    await issue(tenant, lost.id)
    await work(tenant, 'timeout-before-accept')
    await work(tenant, 'timeout-before-accept')
    expect((await serviceDocuments.get(tenant.tenantId, lost.id))?.status).toBe('authorized')
    expect(await observations(tenant, lost.id)).toEqual([
      ['response', 'unknown'],
      ['response', 'authorized'],
    ])
    const generations = await scoped(
      tenant.tenantId,
      (tx) => tx`select document_id from fiscal_nfse_generations order by recorded_at`,
    )
    expect(generations.map((row) => row.document_id)).toEqual([accepted.id, lost.id])
  })

  it('substitutes an NFS-e once and cancels only inside the municipal window', async () => {
    const tenant = await seedTenant()
    const originalOrigin = await serviceOrigin(tenant)
    const original = await authorizeNew(tenant, originalOrigin.id)
    const otherMonth = await serviceOrigin(tenant, { competenceDate: '2026-08-01' })
    await expect(substitute(tenant, original.id, otherMonth.id)).rejects.toBeInstanceOf(
      SubstitutionNotAllowed,
    )
    const corrected = await serviceOrigin(tenant, { amount: '120000' })
    const draft = await substitute(tenant, original.id, corrected.id)
    // A pending substitution blocks cancellation (service and trigger).
    await expect(cancel(tenant, original.id)).rejects.toThrow(/substitution/)
    const replacement = await authorize(tenant, draft.id)
    expect(replacement).toMatchObject({
      status: 'authorized',
      substitutesDocumentId: original.id,
      number: 2,
    })
    const cancelled = await serviceDocuments.get(tenant.tenantId, original.id)
    expect(cancelled).toMatchObject({ status: 'cancelled', substitutedByDocumentId: draft.id })
    const dps = await artifacts.get(
      tenant.tenantId,
      draft.id,
      'signed_xml',
      String(replacement.dpsXmlDigest),
    )
    expect(dps.bytes.toString()).toContain(
      `<subst><chSubstda>${original.nfseKey}</chSubstda><cMotivo>99</cMotivo>`,
    )
    const substitutionEvent = (await artifacts.list(tenant.tenantId, draft.id))?.artifacts.find(
      (artifact) => artifact.kind === 'substitution_event',
    )
    expect(substitutionEvent).toBeDefined()
    const payloads = (await outbox(tenant))
      .filter((row) => row.event_type === fiscalServiceDocumentOutcome.type)
      .map((row) => fiscalServiceDocumentOutcome.payload.parse(row.payload))
    // The substitute and the original's cancellation share one transaction.
    expect(payloads.map((row) => [row.documentId, row.outcome])).toHaveLength(3)
    expect(payloads.map((row) => [row.documentId, row.outcome])).toEqual(
      expect.arrayContaining([
        [original.id, 'authorized'],
        [draft.id, 'authorized'],
        [original.id, 'cancelled'],
      ]),
    )
    expect(payloads.find((row) => row.outcome === 'cancelled')).toMatchObject({
      documentId: original.id,
      cancellation: { kind: 'substitution', substitutedBy: draft.id },
    })
    expect(
      payloads.find((row) => row.documentId === draft.id && row.outcome === 'authorized'),
    ).toMatchObject({ substitutesDocumentId: original.id })
    await expect(
      substitute(tenant, original.id, (await serviceOrigin(tenant, { amount: '110000' })).id),
    ).rejects.toBeInstanceOf(SubstitutionNotAllowed)

    // Event 101101 on the substitute, inside the window.
    await cancel(tenant, draft.id)
    await work(tenant, 'authorized')
    expect((await documents.get(tenant.tenantId, draft.id))?.status).toBe('cancelled')
    const cancellationEvent = fiscalServiceDocumentOutcome.payload.parse(
      (await outbox(tenant)).at(-1)?.payload,
    )
    expect(cancellationEvent).toMatchObject({
      documentId: draft.id,
      outcome: 'cancelled',
      cancellation: { kind: 'event-101101' },
    })

    // After the window it is refused and the NFS-e stays authorized.
    const late = await authorizeNew(tenant, (await serviceOrigin(tenant)).id)
    const afterWindow = new FiscalServiceCancellation(
      url,
      documents,
      artifacts,
      dispatch,
      tenant.profile,
      credential,
      schemaZip,
      () => new Date(Date.now() + (CANCELLATION_DAYS + 2) * 86_400_000),
    )
    services.push(afterWindow)
    await expect(
      afterWindow.request({
        tenantId: tenant.tenantId,
        documentId: late.id,
        idempotencyKey: key(),
        actorId: 'user:reviewer',
        reasonCode: '9',
        reason: 'Cancelamento pedido depois do prazo municipal',
      }),
    ).rejects.toBeInstanceOf(ServiceCancellationWindowElapsed)
    expect((await documents.get(tenant.tenantId, late.id))?.status).toBe('authorized')
  })
})

// Phase 48 reads and support commands over a real NFS-e flow: this file already drives
// every step (lost response, retry, consultation) against PostgreSQL.
describe('Phase 48 worklist and support commands', () => {
  it('lists documents newest first, per tenant, with what is still pending', async () => {
    const tenant = await seedTenant()
    const other = await seedTenant()
    const first = await authorizeNew(tenant, (await serviceOrigin(tenant)).id)
    const waiting = await createDraft(tenant, (await serviceOrigin(tenant)).id)
    await validate(tenant, waiting.id)
    await issue(tenant, waiting.id)
    await work(tenant, 'timeout-after-accept')
    await authorizeNew(other, (await serviceOrigin(other)).id)

    const page = await documentList.list(tenant.tenantId, { limit: 1 })
    expect(page.data).toHaveLength(1)
    expect(page.data[0]).toMatchObject({
      id: waiting.id,
      model: 'nfse',
      status: 'unknown',
      simulated: true,
      fiscalValue: false,
      originKind: 'service',
      statusUrl: `/fiscal/service-documents/${waiting.id}`,
      pending: { kind: 'issuance', state: 'pending' },
    })
    expect(page.page).toMatchObject({ hasMore: true })
    const next = await documentList.list(tenant.tenantId, {
      limit: 1,
      cursor: String(page.page.nextCursor),
    })
    expect(next.data.map((row) => [row.id, row.status, row.number, row.pending])).toEqual([
      [first.id, 'authorized', 1, null],
    ])
    expect(next.page.hasMore).toBe(false)
    expect(
      (await documentList.list(tenant.tenantId, { status: 'authorized', limit: 25 })).data.map(
        (row) => row.id,
      ),
    ).toEqual([first.id])
    expect((await documentList.list(tenant.tenantId, { model: '55', limit: 25 })).data).toEqual([])
    // The other tenant sees only its own document.
    const theirs = await documentList.list(other.tenantId, { limit: 25 })
    expect(theirs.data.map((row) => row.id)).not.toContain(first.id)
    expect(theirs.data).toHaveLength(1)
    await expect(
      documentList.list(tenant.tenantId, { limit: 1, cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(SyntaxError)

    const overview = await support.overview(tenant.tenantId)
    expect(overview).toMatchObject({
      simulationOnly: true,
      documents: { authorized: 1, unknown: 1 },
      unknownOutcomes: 1,
      queue: { pending: 1, leased: 0 },
      imports: { open: 0, blocked: 0, reconciled: 0 },
    })
    expect(overview.outbox.undelivered).toBe(1)
    expect(overview.capabilities).toEqual([
      expect.objectContaining({
        id: tenant.capabilityId,
        model: 'nfse',
        environment: 'simulation',
        jurisdiction: { kind: 'municipality', code: SAO_PAULO },
        status: 'simulated',
      }),
    ])
    expect((await support.overview(other.tenantId)).documents).toEqual({ authorized: 1 })
    const totals = await support.totals([tenant.tenantId, other.tenantId])
    expect(totals).toMatchObject({ unknownOutcomes: 1, queuePending: 1, outboxUndelivered: 2 })
  })

  it('brings a delayed retry forward and reconciles a stuck unknown by consultation', async () => {
    const tenant = await seedTenant()
    const document = await createDraft(tenant, (await serviceOrigin(tenant)).id)
    await validate(tenant, document.id)
    await issue(tenant, document.id)
    await work(tenant, 'timeout-after-accept')
    await scoped(
      tenant.tenantId,
      (tx) => tx`update fiscal_dispatch_jobs set next_attempt_at = now() + interval '1 hour'
        where state = 'pending'`,
    )
    // Not due: the worker leaves it alone until an operator brings it forward.
    await work(tenant, 'timeout-after-accept')
    expect(tenant.calls).toEqual({ submit: 1, consult: 0 })
    const moved = await support.retryDue(tenant.tenantId, 'support:operator', 10)
    expect(moved.changed).toHaveLength(1)
    expect((await support.retryDue(tenant.tenantId, 'support:operator', 10)).changed).toEqual([])
    // A document with a pending command is not reconciled a second time.
    expect(
      (await support.reconcileUnknown(tenant.tenantId, 'support:operator', 10)).skipped,
    ).toEqual([{ id: document.id, reason: 'a command is already pending' }])

    // A crash lost the job: nothing is pending and the outcome is still unknown.
    await scoped(
      tenant.tenantId,
      (tx) => tx`update fiscal_dispatch_jobs set state = 'done', next_attempt_at = now()
        where state = 'pending'`,
    )
    const reconciled = await support.reconcileUnknown(tenant.tenantId, 'support:operator', 10)
    expect(reconciled.changed.map((row) => row.id)).toEqual([document.id])
    expect(reconciled.changed[0]?.detail).toMatch(/^status_query /)
    const again = await support.reconcileUnknown(tenant.tenantId, 'support:operator', 10)
    expect(again.changed).toEqual([])
    await work(tenant, 'authorized')
    // The DPS was consulted, never sent twice (E0014).
    expect(tenant.calls).toEqual({ submit: 1, consult: 1 })
    expect((await serviceDocuments.get(tenant.tenantId, document.id))?.status).toBe('authorized')
    const audit = await scoped(
      tenant.tenantId,
      (tx) => tx`select action from fiscal_audit_entries where action like 'support.%'
        order by sequence`,
    )
    expect(audit.map((row) => row.action)).toEqual([
      'support.retry-due',
      'support.reconcile-unknown',
    ])
    await expect(support.retryDue(tenant.tenantId, 'support:operator', 101)).rejects.toThrow()
  })
})

describe('Phase 50 services delivered in Sales', () => {
  it('issues one NFS-e per delivered line, however the fact is replayed, and cancels it', async () => {
    const tenant = await seedTenant()
    await policies.set({
      tenantId: tenant.tenantId,
      establishmentId: tenant.establishmentId,
      actorId: 'reviewer:phase50-test',
      request: { mode: 'automatic', series: 7, reason: 'Emissão automática revisada no teste' },
    })
    const fact = deliveredFact(tenant, 2)
    const eventId = randomUUID()
    expect(await receive(tenant, 'sales.service.delivered', fact, eventId)).toBe('applied')
    expect(await receive(tenant, 'sales.service.delivered', fact, eventId)).toBe('duplicate')
    // The same facts under a new event id find the same intakes.
    expect(await receive(tenant, 'sales.service.delivered', fact)).toBe('applied')
    await expect(
      receive(tenant, 'sales.service.delivered', {
        ...fact,
        lines: [{ ...fact.lines[0], amount: { amount: '1', currency: 'BRL' } }],
      }),
    ).rejects.toThrow(/Conflicting service delivery facts/)

    const intakes = intakesOf(tenant)
    while (await intakes.processOne(tenant.tenantId));
    await work(tenant, 'authorized')
    await work(tenant, 'authorized')
    const listed = await intakes.list(tenant.tenantId)
    expect(listed).toHaveLength(2)
    expect(listed.map((intake) => intake.status)).toEqual(['issuing', 'issuing'])
    const documentIds = listed.map((intake) => String(intake.documentId))
    for (const documentId of documentIds)
      expect(await serviceDocuments.get(tenant.tenantId, documentId)).toMatchObject({
        status: 'authorized',
        series: 7,
      })
    const origins = await scoped(
      tenant.tenantId,
      (tx) => tx`select source_module, source_document_type, source_id, source_period
        from fiscal_service_origins order by source_id`,
    )
    expect(
      origins.map((row) => [row.source_module, row.source_document_type, row.source_period]),
    ).toEqual([
      ['sales', 'service-delivery', '2026-09'],
      ['sales', 'service-delivery', '2026-09'],
    ])
    expect(origins.map((row) => row.source_id).sort()).toEqual(
      fact.lines.map((line) => line.entryId).sort(),
    )

    await receive(tenant, 'sales.service.delivery-cancelled', cancelledFact(fact))
    while (await intakes.processOne(tenant.tenantId));
    await work(tenant, 'authorized')
    await work(tenant, 'authorized')
    await forceDue(tenant)
    while (await intakes.processOne(tenant.tenantId));
    for (const documentId of documentIds)
      expect((await serviceDocuments.get(tenant.tenantId, documentId))?.status).toBe('cancelled')
    expect((await intakes.list(tenant.tenantId)).map((intake) => intake.status)).toEqual([
      'withdrawn',
      'withdrawn',
    ])
    const cancellations = (await outbox(tenant)).filter(
      (row) => row.payload.outcome === 'cancelled',
    )
    expect(cancellations).toHaveLength(2)
    expect(cancellations[0]?.payload.sourceKey).toMatchObject({
      module: 'sales',
      documentType: 'service-delivery',
      period: '2026-09',
    })
  })

  it('blocks an intake with its reason, retries it and withdraws its draft', async () => {
    const tenant = await seedTenant()
    const unprofiled = randomUUID()
    catalogServices.add(unprofiled)
    const fact = deliveredFact(tenant, 1, unprofiled)
    await receive(tenant, 'sales.service.delivered', fact)
    const intakes = intakesOf(tenant)
    expect(await intakes.processOne(tenant.tenantId)).toBe(true)
    const [blocked] = await intakes.list(tenant.tenantId, { status: 'blocked' })
    expect(blocked).toMatchObject({ attempts: 1, serviceOriginId: null })
    expect(blocked?.reason).toMatch(/^SERVICE_PROFILE_MISSING/)
    // Not due again until its backoff, unless someone asks.
    expect(await intakes.processOne(tenant.tenantId)).toBe(false)

    await profiles.create({
      tenantId: tenant.tenantId,
      actorId: 'reviewer:phase50-test',
      request: {
        itemId: unprofiled,
        nationalTaxCode: '010101',
        nbsCode: '115022000',
        issTaxation: '1',
        description: 'Suporte técnico',
        effectiveFrom: '2026-01-01',
        reason: 'Classificação revisada no teste da fase 50',
      },
    })
    await intakes.retry(tenant.tenantId, String(blocked?.id), 'user:operator')
    expect(await intakes.processOne(tenant.tenantId)).toBe(true)
    const [drafted] = await intakes.list(tenant.tenantId)
    // Nothing configured means review: the draft waits for a person.
    expect(drafted).toMatchObject({ status: 'drafted', reason: null, nextAttemptAt: null })
    const documentId = String(drafted?.documentId)
    expect((await serviceDocuments.get(tenant.tenantId, documentId))?.status).toBe('draft')
    await expect(
      intakes.retry(tenant.tenantId, String(blocked?.id), 'user:operator'),
    ).rejects.toThrow(/not blocked/)

    await receive(tenant, 'sales.service.delivery-cancelled', cancelledFact(fact))
    expect(await intakes.processOne(tenant.tenantId)).toBe(true)
    expect((await intakes.list(tenant.tenantId))[0]).toMatchObject({
      status: 'withdrawn',
      withdrawalRequested: true,
    })
    await validate(tenant, documentId)
    await expect(issue(tenant, documentId)).rejects.toThrow(/withdrawn in Sales/)
    await expect(
      scoped(tenant.tenantId, (tx) => tx`update fiscal_service_intakes set status = 'pending'`),
    ).rejects.toThrow(/only moves forward/)

    // Another tenant sees none of it.
    const other = await seedTenant()
    expect(await intakesOf(other).list(other.tenantId)).toEqual([])
    expect(
      await scoped(other.tenantId, (tx) => tx`select 1 from fiscal_service_intakes`),
    ).toHaveLength(0)
  })

  it('withdraws a delivery cancelled while its draft was being made', async () => {
    const tenant = await seedTenant()
    const fact = deliveredFact(tenant, 1)
    await receive(tenant, 'sales.service.delivered', fact)
    const intakes = new FiscalServiceIntakes(url, {
      projections,
      capabilities,
      profiles,
      origins,
      documents: {
        get: (tenantId, documentId) => serviceDocuments.get(tenantId, documentId),
        async createDraft(input) {
          // The cancellation lands between the claim and the record of this step.
          await receive(tenant, 'sales.service.delivery-cancelled', cancelledFact(fact))
          return serviceDocuments.createDraft(input)
        },
      },
      readiness,
      policies,
      issuance: tenant.issuance,
      cancellation: tenant.cancellation,
    })
    services.push(intakes)
    expect(await intakes.processOne(tenant.tenantId)).toBe(true)
    const [drafted] = await intakes.list(tenant.tenantId)
    expect(drafted).toMatchObject({ status: 'drafted', withdrawalRequested: true })
    expect(drafted?.nextAttemptAt).not.toBeNull()
    expect(await intakes.processOne(tenant.tenantId)).toBe(true)
    expect((await intakes.list(tenant.tenantId))[0]?.status).toBe('withdrawn')
  })

  it('waits for a cancellation that overtakes its delivery', async () => {
    const tenant = await seedTenant()
    const fact = deliveredFact(tenant, 1)
    await expect(
      receive(tenant, 'sales.service.delivery-cancelled', cancelledFact(fact)),
    ).rejects.toThrow(/has not been received yet/)
    // Rolled back with its inbox claim, so the redelivery is handled once it can be.
    await receive(tenant, 'sales.service.delivered', fact)
    await receive(tenant, 'sales.service.delivery-cancelled', cancelledFact(fact))
    expect(await intakesOf(tenant).processOne(tenant.tenantId)).toBe(true)
    expect((await intakesOf(tenant).list(tenant.tenantId))[0]?.status).toBe('withdrawn')
  })
})

describe('Phase 52 contract periods billed in Sales', () => {
  it('issues one NFS-e per billed line, however the period is replayed, and cancels it on a credit', async () => {
    const tenant = await seedTenant()
    await policies.set({
      tenantId: tenant.tenantId,
      establishmentId: tenant.establishmentId,
      actorId: 'reviewer:phase52-test',
      request: { mode: 'automatic', series: 8, reason: 'Emissão automática revisada no teste' },
    })
    const fact = billedFact(tenant)
    const eventId = randomUUID()
    expect(await receive(tenant, 'sales.contract-period.billed', fact, eventId)).toBe('applied')
    expect(await receive(tenant, 'sales.contract-period.billed', fact, eventId)).toBe('duplicate')
    expect(await receive(tenant, 'sales.contract-period.billed', fact)).toBe('applied')
    // A delivery in the same month lists apart from the contract's periods.
    await receive(tenant, 'sales.service.delivered', deliveredFact(tenant, 1))

    const reasonCodes: string[] = []
    const intakes = intakesOf(tenant, {
      request: (input) => {
        reasonCodes.push(input.reasonCode)
        return tenant.cancellation.request(input)
      },
    })
    while (await intakes.processOne(tenant.tenantId));
    await work(tenant, 'authorized')
    await work(tenant, 'authorized')
    const listed = await intakes.list(tenant.tenantId, {
      documentType: 'contract-period',
      period: '2026-09',
    })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      status: 'issuing',
      sourceKey: { module: 'sales', documentType: 'contract-period', period: '2026-09' },
      billedPeriodId: fact.billedPeriodId,
      contractId: fact.contractId,
      deliveryId: null,
      serviceOrderId: null,
      competenceDate: '2026-09-01',
    })
    expect(await intakes.list(tenant.tenantId, { period: '2026-08' })).toEqual([])
    const documentId = String(listed[0]?.documentId)
    expect(await serviceDocuments.get(tenant.tenantId, documentId)).toMatchObject({
      status: 'authorized',
      series: 8,
    })
    const [origin] = await scoped(
      tenant.tenantId,
      (tx) => tx`select source_document_type, source_id from fiscal_service_origins
        where source_document_type = 'contract-period'`,
    )
    expect(origin).toMatchObject({
      source_document_type: 'contract-period',
      source_id: fact.lines[0]?.entryId,
    })

    await expect(
      receive(tenant, 'sales.contract-period.credited', {
        ...creditedFact(fact),
        billedPeriodId: randomUUID(),
      }),
    ).rejects.toThrow(/has not been received yet/)
    await receive(tenant, 'sales.contract-period.credited', creditedFact(fact))
    while (await intakes.processOne(tenant.tenantId));
    await work(tenant, 'authorized')
    await forceDue(tenant)
    while (await intakes.processOne(tenant.tenantId));
    expect((await serviceDocuments.get(tenant.tenantId, documentId))?.status).toBe('cancelled')
    expect(reasonCodes).toEqual(['1'])
    const [withdrawn] = await intakes.list(tenant.tenantId, { documentType: 'contract-period' })
    expect(withdrawn).toMatchObject({ status: 'withdrawn', withdrawalRequested: true })
    const cancelled = (await outbox(tenant)).filter(
      (row) =>
        row.payload.outcome === 'cancelled' &&
        row.payload.sourceKey?.documentType === 'contract-period',
    )
    expect(cancelled).toHaveLength(1)
    await expect(
      scoped(
        tenant.tenantId,
        (tx) => tx`update fiscal_service_intakes set withdrawal_code = '2'
          where billed_period_id = ${fact.billedPeriodId}`,
      ),
    ).rejects.toThrow(/only moves forward/)
  })
})

function billedFact(tenant: Tenant) {
  const delivered = deliveredFact(tenant, 1)
  return {
    contractId: randomUUID(),
    billedPeriodId: randomUUID(),
    customerId: tenant.recipientId,
    competence: '2026-09',
    revision: 1,
    startsOn: '2026-09-01',
    endsOn: '2026-09-30',
    issuedOn: '2026-09-05',
    lines: delivered.lines,
    value: delivered.value,
    installments: delivered.installments,
    runId: randomUUID(),
    billedBy: 'user:operator',
  }
}

function creditedFact(fact: ReturnType<typeof billedFact>) {
  return {
    contractId: fact.contractId,
    billedPeriodId: fact.billedPeriodId,
    customerId: fact.customerId,
    competence: fact.competence,
    entryIds: fact.lines.map((line) => line.entryId),
    reasonCode: 'billing-error',
    reason: 'Faturado com o posto errado',
    creditedOn: '2026-09-21',
  }
}

function intakesOf(
  tenant: Tenant,
  cancellation: Pick<Tenant['cancellation'], 'request'> = tenant.cancellation,
) {
  const intakes = new FiscalServiceIntakes(url, {
    projections,
    capabilities,
    profiles,
    origins,
    documents: serviceDocuments,
    readiness,
    policies,
    issuance: tenant.issuance,
    cancellation,
  })
  services.push(intakes)
  return intakes
}

function deliveredFact(tenant: Tenant, lines: number, itemId = tenant.serviceItemId) {
  return {
    serviceOrderId: randomUUID(),
    deliveryId: randomUUID(),
    customerId: tenant.recipientId,
    performedOn: '2026-09-20',
    competence: '2026-09',
    deliveredBy: 'user:operator',
    lines: Array.from({ length: lines }, (_, index) => ({
      entryId: randomUUID(),
      lineId: randomUUID(),
      itemId,
      description: `Desenvolvimento de sistema sob medida, etapa ${index + 1}`,
      quantity: '1',
      unitPrice: { amount: '75000', currency: 'BRL' },
      amount: { amount: '75000', currency: 'BRL' },
    })),
    value: { amount: String(75000 * lines), currency: 'BRL' },
    installments: [
      {
        number: 1,
        dueOn: '2026-10-20',
        amount: { amount: String(75000 * lines), currency: 'BRL' },
      },
    ],
    complete: true,
  }
}

function cancelledFact(fact: ReturnType<typeof deliveredFact>) {
  return {
    serviceOrderId: fact.serviceOrderId,
    deliveryId: fact.deliveryId,
    customerId: fact.customerId,
    competence: fact.competence,
    entryIds: fact.lines.map((line) => line.entryId),
    cancelledOn: '2026-09-21',
    reason: 'O cliente cancelou a entrega',
  }
}

function receive(tenant: Tenant, eventType: string, payload: unknown, eventId = randomUUID()) {
  return ingress.accept({
    eventId,
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId: tenant.tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload,
  })
}

/** Brings every waiting intake forward, as the passing of its wait would. */
function forceDue(tenant: Tenant) {
  return scoped(
    tenant.tenantId,
    (tx) => tx`update fiscal_service_intakes set next_attempt_at = now()
      where next_attempt_at is not null`,
  )
}

async function seedTenant(options: { municipality?: string } = {}): Promise<Tenant> {
  const municipality = options.municipality ?? SAO_PAULO
  const tenantId = randomUUID()
  const establishmentId = randomUUID()
  const recipientId = randomUUID()
  const serviceItemId = randomUUID()
  catalogServices.add(serviceItemId)
  const owner = postgres(container.getConnectionUri(), { max: 1 })
  await owner`insert into tenants (id) values (${tenantId})`
  await owner.end()
  const version = await registry.importVersion({
    tenantId,
    actorId: 'agent:test',
    request: phase47RegistryVersion(),
  })
  await registry.review({
    tenantId,
    versionId: version.id,
    actorId: 'reviewer:phase47-test',
    interpretation: 'Approved only inside the isolated Phase 47 integration test.',
  })
  if (municipality === SAO_PAULO)
    for (const source of [
      approvedPhase47IbsCbsSource(tenantId, SAO_PAULO),
      approvedPhase47IssSource(tenantId, SAO_PAULO),
    ]) {
      const imported = await store.importSource(source)
      await store.reviewPackage({
        tenantId,
        packageId: imported.packageId,
        approved: true,
        reviewedBy: 'reviewer:phase47-test',
        reviewedAt: '2026-09-26T12:00:00.000Z',
        interpretation: 'Approved only inside the isolated Phase 47 integration test.',
        fixtureIds: [PHASE47_FIXTURE],
      })
      for (const ruleId of imported.ruleIds)
        await store.activateRule({
          tenantId,
          ruleId,
          action: 'activate',
          actorId: 'test:phase47',
          reason: 'Isolated Phase 47 integration fixture',
        })
    }
  const definition = await capabilities.register({
    tenantId,
    model: 'nfse',
    environment: 'simulation',
    establishmentId,
    jurisdictionKind: 'municipality',
    jurisdictionCode: municipality,
    operation: 'service-provision',
    adapterVersion: PHASE47_ADAPTER,
    sourceManifestDigest: '7'.repeat(64),
    schemaPackageDigest: 'e7935cbd9470527c6cc32984c1b2263e614183bf0139ce2733eaaed2de9a8072',
    calculationFixtureId: PHASE47_FIXTURE,
    createdBy: 'test:phase47',
  })
  await capabilities.review({
    tenantId,
    capabilityId: definition.id,
    approved: true,
    reviewedBy: 'reviewer:phase47-test',
    interpretation: 'Test-only authorization of the Phase 47 simulation tuple.',
    reviewedAt: '2026-09-26T12:00:00.000Z',
  })
  await capabilities.change({
    tenantId,
    capabilityId: definition.id,
    action: 'activate_simulated',
    evidenceDigest: '9'.repeat(64),
    actorId: 'test:phase47',
    reason: 'Activate only the isolated Phase 47 test fixture.',
    occurredAt: '2026-09-26T12:01:00.000Z',
  })
  await projections.storeIssuer(tenantId, 1, {
    tenantId,
    revision: 1,
    effectiveFrom: '2026-01-01',
    timezone: 'America/Sao_Paulo',
    company: {
      legalName: 'Horizon Serviços de Software LTDA',
      tradeName: null,
      taxId: ISSUER_CNPJ,
      stateRegistration: null,
      municipalRegistration: null,
      address: {
        line: 'Rua Um, 1',
        city: municipality === SAO_PAULO ? 'São Paulo' : 'Campinas',
        municipalityCode: municipality,
        state: 'SP',
        postalCode: '01001000',
        country: 'BR',
      },
      baseCurrency: 'BRL',
      fiscalRegime: 'lucro-presumido',
    },
  })
  await projections.storeParty(tenantId, recipientId, 1, {
    tenantId,
    partyId: recipientId,
    kind: 'organization',
    legalName: 'Cliente de Serviços LTDA',
    tradeName: null,
    taxId: '44555666000105',
    revision: 1,
    profile: {
      effectiveFrom: '2026-01-01',
      stateRegistration: null,
      municipalRegistration: null,
      taxpayerIndicator: 'non-contributor',
      finalConsumer: false,
      address: {
        street: 'Avenida Paulista',
        number: '1000',
        complement: 'Conjunto 101',
        district: 'Bela Vista',
        city: 'São Paulo',
        municipalityCode: SAO_PAULO,
        state: 'SP',
        postalCode: '01310-100',
        country: 'BR',
      },
    },
  })
  const saved = await profiles.create({
    tenantId,
    actorId: 'reviewer:phase47-test',
    request: {
      itemId: serviceItemId,
      nationalTaxCode: '010101',
      nbsCode: '115022000',
      issTaxation: '1',
      description: 'Desenvolvimento de sistemas sob medida',
      effectiveFrom: '2026-01-01',
      reason: 'Classificação revisada do serviço de software',
    },
  })
  const profile: ServiceProfile = {
    capabilityId: definition.id,
    municipalityCode: municipality,
    cancellationWindowDays: CANCELLATION_DAYS,
    substitutionWindowDays: SUBSTITUTION_DAYS,
    operationIndicator: '100301',
    ibsCbs: { cst: '000', classification: '000001' },
  }
  const issuance = new FiscalServiceIssuance(
    url,
    documents,
    projections,
    calculations,
    artifacts,
    dispatch,
    registry,
    profile,
    credential,
    schemaZip,
  )
  const cancellation = new FiscalServiceCancellation(
    url,
    documents,
    artifacts,
    dispatch,
    profile,
    credential,
    schemaZip,
  )
  const substitutions = new FiscalServiceSubstitutions(url, serviceDocuments, origins, profile)
  const facts = new NfseProcessingFacts(url, projections, calculations, artifacts, {
    street: 'Rua Um',
    number: '1',
    district: 'Centro',
  })
  services.push(issuance, cancellation, substitutions, facts)
  return {
    tenantId,
    establishmentId,
    recipientId,
    serviceItemId,
    profileRevision: saved.revision,
    capabilityId: definition.id,
    profile,
    issuance,
    cancellation,
    substitutions,
    facts,
    calls: { submit: 0, consult: 0 },
  }
}

function serviceOrigin(
  tenant: Tenant,
  overrides: {
    sourceKey?: { module: string; documentType: string; id: string; period: string }
    amount?: string
    competenceDate?: string
  } = {},
) {
  return origins.create({
    tenantId: tenant.tenantId,
    idempotencyKey: key(),
    actorId: 'user:reviewer',
    request: {
      establishmentId: tenant.establishmentId,
      issuerProfileRevision: 1,
      recipientPartyId: tenant.recipientId,
      recipientProfileRevision: 1,
      serviceItemId: tenant.serviceItemId,
      serviceProfileRevision: tenant.profileRevision,
      competenceDate: overrides.competenceDate ?? '2026-09-01',
      amount: { amount: overrides.amount ?? '150000', currency: 'BRL' },
      description: 'Desenvolvimento de sistema sob medida',
      reason: 'Serviço prestado e revisado pelo emissor',
      ...(overrides.sourceKey ? { sourceKey: overrides.sourceKey } : {}),
    },
  })
}

function createDraft(tenant: Tenant, serviceOriginId: string) {
  return serviceDocuments.createDraft({
    tenantId: tenant.tenantId,
    serviceOriginId,
    establishmentId: tenant.establishmentId,
    series: 1,
    idempotencyKey: key(),
    actorId: 'user:reviewer',
  })
}

async function validate(tenant: Tenant, documentId: string) {
  const ready = await readiness.validate({
    tenantId: tenant.tenantId,
    documentId,
    actorId: 'user:reviewer',
  })
  expect(ready.supported, JSON.stringify(ready)).toBe(true)
  return ready
}

function issue(tenant: Tenant, documentId: string) {
  return tenant.issuance.issue({
    tenantId: tenant.tenantId,
    documentId,
    idempotencyKey: key(),
    actorId: 'user:reviewer',
  })
}

async function authorize(tenant: Tenant, documentId: string) {
  await validate(tenant, documentId)
  await issue(tenant, documentId)
  await work(tenant, 'authorized')
  const document = await serviceDocuments.get(tenant.tenantId, documentId)
  if (!document) throw new Error('document vanished')
  return document
}

async function authorizeNew(tenant: Tenant, serviceOriginId: string) {
  return authorize(tenant, (await createDraft(tenant, serviceOriginId)).id)
}

function substitute(tenant: Tenant, documentId: string, correctedServiceOriginId: string) {
  return tenant.substitutions.request({
    tenantId: tenant.tenantId,
    documentId,
    idempotencyKey: key(),
    actorId: 'user:reviewer',
    reasonCode: '99',
    reason: 'Valor do serviço revisado com o cliente',
    correctedServiceOriginId,
  })
}

function cancel(tenant: Tenant, documentId: string) {
  return tenant.cancellation.request({
    tenantId: tenant.tenantId,
    documentId,
    idempotencyKey: key(),
    actorId: 'user:reviewer',
    reasonCode: '2',
    reason: 'Serviço não foi prestado ao cliente',
  })
}

async function work(tenant: Tenant, scenario: SimulatorScenario) {
  const simulator = new DeterministicNfseSimulator(
    PHASE47_MUNICIPAL_PARAMETERS,
    PHASE47_IBS_CBS_RATES,
    credential,
    () => scenario,
  )
  const counted = {
    submit: (input: Parameters<typeof simulator.submit>[0]) => {
      tenant.calls.submit += 1
      return simulator.submit(input)
    },
    consult: (input: Parameters<typeof simulator.consult>[0]) => {
      tenant.calls.consult += 1
      return simulator.consult(input)
    },
    submitCancellation: simulator.submitCancellation.bind(simulator),
    consultCancellation: simulator.consultCancellation.bind(simulator),
  }
  await new FiscalIssueWorker(
    dispatch,
    artifacts,
    new DeterministicNfe55Simulator(() => scenario),
    0,
    undefined,
    new NfseDispatchProcessor(dispatch, artifacts, counted, tenant.facts, 0),
  ).processOne(tenant.tenantId, 'worker:phase47')
}

async function observations(tenant: Tenant, documentId: string) {
  const rows = await scoped(
    tenant.tenantId,
    (tx) => tx`select observation.observation_kind, observation.outcome
      from fiscal_dispatch_observations observation
      join fiscal_dispatch_commands command on command.tenant_id = observation.tenant_id
        and command.id = observation.command_id
      where command.document_id = ${documentId} order by observation.observed_at, observation.id`,
  )
  return rows.map((row) => [row.observation_kind, row.outcome])
}

async function outbox(tenant: Tenant) {
  return scoped(
    tenant.tenantId,
    (tx) => tx`select event_type, payload from fiscal_outbox order by created_at, event_id`,
  )
}

function key(): string {
  return `phase47-${randomUUID()}`
}

async function scoped<T>(
  tenantId: string,
  work: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const sql = postgres(url, { max: 1 })
  try {
    return (await sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return work(tx)
    })) as T
  } finally {
    await sql.end()
  }
}

async function selfSigned(root: string): Promise<SimulationCredential> {
  const keyPath = join(root, 'simulation-only.key.pem')
  const certificatePath = join(root, 'simulation-only.cert.pem')
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '1',
    '-subj',
    '/CN=Horizon Phase 47 Simulation Only',
    '-keyout',
    keyPath,
    '-out',
    certificatePath,
  ])
  return { privateKey: await readFile(keyPath), certificate: await readFile(certificatePath) }
}
