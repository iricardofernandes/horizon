import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fiscalConsumerDocumentOutcome, fiscalDocumentAuthorized } from '@horizon/contracts'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { PDFDocument } from 'pdf-lib'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EncryptedFiscalArtifactStore, LocalObjectStore } from '../src/artifact-store'
import { FiscalArtifacts } from '../src/artifacts'
import { type AuditRow, verifyAuditRows } from '../src/audit'
import { FiscalCalculations } from '../src/calculations'
import { CancellationWindowElapsed, FiscalCancellation } from '../src/cancellation'
import { FiscalCapabilities } from '../src/capabilities'
import { CorrectionLetterError, FiscalCorrectionLetters } from '../src/correction-letters'
import { FiscalDispatch } from '../src/dispatch'
import { PHASE46_FIXTURE } from '../src/document-kinds'
import { FiscalDocuments, FiscalModelConflict } from '../src/documents'
import { FiscalIngress } from '../src/ingress'
import { FiscalIssuance, type Nfe55SimulationProfile } from '../src/issuance'
import { FiscalIssueWorker } from '../src/issue-worker'
import { FiscalLinkedOrigins } from '../src/linked-origins'
import { ReadinessStale } from '../src/nfce65/build'
import { parseOnlineQrCodeV3 } from '../src/nfce65/qr-code'
import { DeterministicNfce65Simulator, NFCE_MAX_EMISSION_DELAY_MS } from '../src/nfce65/simulator'
import type { SimulationCredential } from '../src/nfe55/signature'
import { DeterministicNfe55Simulator, type SimulatorScenario } from '../src/nfe55/simulator'
import { approvedPhase41Source, PHASE41_FIXTURE_ID } from '../src/phase41-approved-scenario'
import { approvedPhase46Source } from '../src/phase46-approved-scenario'
import { FiscalProjections } from '../src/projections'
import { ConsumerNotEligible, FiscalReadiness } from '../src/readiness'
import { FiscalRuleStore } from '../src/rule-store'
import { supplierCredential } from './support/inbound-nfe'

const run = promisify(execFile)
const DOCUMENT_SCHEMA = 'b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998'
const EVENT_SCHEMA = '45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b'
const ISSUER = '98765432000100'
const COFFEE_NCM = '09012100'
const WINDOW_MINUTES = 30

let container: StartedPostgreSqlContainer
let admin: ReturnType<typeof postgres>
let url: string
let directory: string
let masterKey: Buffer
let issuerCredential: SimulationCredential
let ingress: FiscalIngress
let projections: FiscalProjections
let store: FiscalRuleStore
let calculations: FiscalCalculations
let capabilities: FiscalCapabilities
let documents: FiscalDocuments
let dispatch: FiscalDispatch
let artifacts: FiscalArtifacts
let readiness: FiscalReadiness
let linkedOrigins: FiscalLinkedOrigins
let documentZip: Buffer
let eventZip: Buffer
const services: Array<{ close(): Promise<void> }> = []

type Tenant = {
  tenantId: string
  establishmentId: string
  /** A person buying for themselves: CPF, final consumer, not an ICMS contributor. */
  consumerId: string
  /** A company that pays ICMS: never an NFC-e recipient. */
  contributorId: string
  /** A final consumer living in another UF. */
  remoteConsumerId: string
  coffeeId: string
  capabilities: { sale: string; consumer: string }
  profile: Nfe55SimulationProfile
  issuance: FiscalIssuance
  cancellation: FiscalCancellation
  letters: FiscalCorrectionLetters
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('horizon_phase46_nfce_test')
    .withUsername('postgres')
    .withPassword('test')
    .start()
  admin = postgres(container.getConnectionUri(), { max: 1 })
  await admin.unsafe(
    `CREATE ROLE horizon_owner LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_app LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     REVOKE ALL ON SCHEMA public FROM PUBLIC;
     GRANT USAGE ON SCHEMA public TO horizon_app;
     GRANT USAGE, CREATE ON SCHEMA public TO horizon_owner;`,
    [],
    { prepare: false },
  )
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
  directory = await mkdtemp(join(tmpdir(), 'horizon-phase46-'))
  masterKey = randomBytes(32)
  await mkdir(join(directory, 'issuer'))
  issuerCredential = await supplierCredential(join(directory, 'issuer'), ISSUER)
  documentZip = await readFile(new URL('../fixtures/official/pl-010f-v1.04.zip', import.meta.url))
  eventZip = await readFile(new URL('../fixtures/official/pl-010d-v1.03.zip', import.meta.url))
  ingress = new FiscalIngress(url, masterKey)
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
  readiness = new FiscalReadiness(documents, projections, capabilities, calculations)
  linkedOrigins = new FiscalLinkedOrigins(url, masterKey, documents, () => ({
    async catalogItem(id) {
      return { id, kind: 'product', name: 'Café torrado em grãos', active: true }
    },
  }))
  services.push(
    ingress,
    projections,
    store,
    calculations,
    capabilities,
    documents,
    dispatch,
    artifacts,
    linkedOrigins,
  )
}, 180_000)

afterAll(async () => {
  await Promise.allSettled([...services.map((service) => service.close()), admin?.end()])
  await container?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('Phase 46 NFC-e model 65', () => {
  it('issues a consumer sale as an NFC-e with its own XML, QR code, series and DANFE', async () => {
    const tenant = await seedTenant()
    const nfce = await authorizeNew(tenant, tenant.consumerId, '65')
    expect(nfce).toMatchObject({ model: '65', status: 'authorized', number: 1 })
    const xml = await signedXml(tenant, nfce.id)
    for (const fragment of [
      '<mod>65</mod>',
      '<tpImp>4</tpImp>',
      '<indFinal>1</indFinal>',
      '<indPres>4</indPres>',
      '<CPF>12345678909</CPF>',
      '<indIEDest>9</indIEDest>',
      '<tPag>05</tPag>',
      '<natOp>Venda a consumidor final</natOp>',
    ])
      expect(xml).toContain(fragment)
    const qrCode = /<qrCode>([^<]+)<\/qrCode>/.exec(xml)?.[1] ?? ''
    expect(parseOnlineQrCodeV3(qrCode)).toMatchObject({
      accessKey: nfce.accessKey,
      version: '3',
      environment: '2',
    })
    expect(xml.indexOf('</infNFeSupl><Signature')).toBeGreaterThan(0)

    // The model 55 counter is separate: an NF-e in the same series also starts at 1.
    const nfe = await authorizeNew(tenant, tenant.contributorId, '55')
    expect(nfe).toMatchObject({ model: '55', status: 'authorized', number: 1 })
    expect(nfe.accessKey?.slice(20, 22)).toBe('55')
    expect(nfce.accessKey?.slice(20, 22)).toBe('65')

    const listed = await artifacts.list(tenant.tenantId, nfce.id)
    const danfes = listed?.artifacts.filter((artifact) => artifact.kind === 'danfe') ?? []
    expect(danfes.map((artifact) => artifact.sourceSchema).sort()).toEqual([
      'horizon-danfe-nfce-authorized-v1',
      'horizon-danfe-nfce-preview-v1',
    ])
    const authorized = danfes.find(
      (artifact) => artifact.sourceSchema === 'horizon-danfe-nfce-authorized-v1',
    )
    const pdf = await artifacts.get(tenant.tenantId, nfce.id, 'danfe', String(authorized?.digest))
    const loaded = await PDFDocument.load(pdf.bytes)
    expect(loaded.getTitle()).toContain('NFC-e')
    expect(Math.round((loaded.getPages()[0]?.getWidth() ?? 0) / (72 / 25.4))).toBe(80)

    const events = await outbox(tenant)
    const consumer = events.filter((row) => row.event_type === fiscalConsumerDocumentOutcome.type)
    expect(consumer).toHaveLength(1)
    const payload = fiscalConsumerDocumentOutcome.payload.parse(consumer[0]?.payload)
    expect(payload).toMatchObject({
      documentId: nfce.id,
      outcome: 'authorized',
      model: '65',
      source: { module: 'sales', documentType: 'shipment' },
    })
    expect(payload.correlations.map((row) => row.sourceEvent)).toEqual([
      'sales.shipment.dispatched',
      'sales.shipment.dispatched',
    ])
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain(String(nfce.accessKey))
    expect(serialized).not.toContain('12345678909')
    // The model 55 event carries only the NF-e.
    expect(
      events
        .filter((row) => row.event_type === fiscalDocumentAuthorized.type)
        .map((row) => (row.payload as { documentId: string }).documentId),
    ).toEqual([nfe.id])
    // Fiscal never publishes a stock or money effect.
    expect(events.every((row) => String(row.event_type).startsWith('fiscal.'))).toBe(true)
    const audit = await scoped(
      tenant.tenantId,
      (tx) => tx<AuditRow[]>`select * from fiscal_audit_entries order by sequence`,
    )
    expect(verifyAuditRows(audit)).toBe(true)
  })

  it('keeps one sale to one model and one live document, whatever is replayed', async () => {
    const tenant = await seedTenant()
    const shipmentId = randomUUID()
    const event = originEvent(tenant, shipmentId, tenant.consumerId)
    expect(await ingress.accept(event)).toBe('applied')
    expect(await ingress.accept(event)).not.toBe('applied')
    const intentId = await intentOf(tenant, shipmentId)
    const createKey = key()
    const draft = await createDraft(tenant, intentId, '65', createKey)
    expect((await createDraft(tenant, intentId, '65', createKey)).id).toBe(draft.id)
    expect((await createDraft(tenant, intentId, '65')).id).toBe(draft.id)
    await expect(createDraft(tenant, intentId, '55')).rejects.toBeInstanceOf(FiscalModelConflict)
    // The same rule holds in the database, for a successor or a direct write.
    await expect(
      admin`insert into fiscal_documents (id, tenant_id, intent_id, model, environment,
          establishment_id, series, snapshot_digest, snapshot_ciphertext, root_document_id)
        values (${randomUUID()}, ${tenant.tenantId}, ${intentId}, '55', 'simulation',
          ${tenant.establishmentId}, 2, ${'a'.repeat(64)}, ${Buffer.from('x')}, ${randomUUID()})`,
    ).rejects.toThrow(/keeps the model|fiscal_document/)

    const authorized = await authorize(tenant, draft.id)
    expect(authorized.status).toBe('authorized')
    // Replaying the worker and the origin changes nothing.
    await work(tenant, 'authorized')
    expect(await ingress.accept(event)).not.toBe('applied')
    const rows = await scoped(
      tenant.tenantId,
      (tx) => tx`select id, model, status from fiscal_documents where intent_id = ${intentId}`,
    )
    expect(rows).toEqual([{ id: draft.id, model: '65', status: 'authorized' }])
    const events = (await outbox(tenant)).filter(
      (row) => row.event_type === fiscalConsumerDocumentOutcome.type,
    )
    expect(events).toHaveLength(1)
  })

  it('refuses an NFC-e for a contributor, another UF, a stale day and every other flow', async () => {
    const tenant = await seedTenant()
    const contributor = await draftFor(tenant, tenant.contributorId, '65')
    await expect(validate(tenant, contributor.id)).rejects.toBeInstanceOf(ConsumerNotEligible)
    const remote = await draftFor(tenant, tenant.remoteConsumerId, '65')
    await expect(validate(tenant, remote.id)).rejects.toThrow('Fiscal capability is unsupported')

    const stale = await draftFor(tenant, tenant.consumerId, '65')
    await validate(tenant, stale.id)
    const tomorrow = new FiscalIssuance(
      url,
      documents,
      projections,
      calculations,
      artifacts,
      dispatch,
      tenant.profile,
      issuerCredential,
      documentZip,
      DOCUMENT_SCHEMA,
      () => new Date(Date.now() + 36 * 3_600_000),
    )
    services.push(tomorrow)
    await expect(
      tomorrow.issue({
        tenantId: tenant.tenantId,
        documentId: stale.id,
        idempotencyKey: key(),
        actorId: 'user:cashier',
      }),
    ).rejects.toBeInstanceOf(ReadinessStale)

    const sale = await authorizeNew(tenant, tenant.consumerId, '65')
    const shipmentId = await shipmentOf(tenant, sale.id)
    expect(await ingress.accept(originEvent(tenant, shipmentId, tenant.consumerId, 'return'))).toBe(
      'applied',
    )
    await expect(
      linkedOrigins.create({
        tenantId: tenant.tenantId,
        idempotencyKey: key(),
        actorId: 'user:cashier',
        request: { kind: 'sale-return', shipmentId },
      }),
    ).rejects.toMatchObject({ code: 'KIND_UNSUPPORTED' })
    await expect(
      tenant.letters.request({
        tenantId: tenant.tenantId,
        documentId: sale.id,
        idempotencyKey: key(),
        actorId: 'user:cashier',
        text: 'Correção do endereço de entrega do consumidor final',
        attestation: true,
      }),
    ).rejects.toBeInstanceOf(CorrectionLetterError)
  })

  it('consults after an outage, rejects a late recovery and corrects it with a successor', async () => {
    const tenant = await seedTenant()
    const draft = await draftFor(tenant, tenant.consumerId, '65')
    await validate(tenant, draft.id)
    await issue(tenant, draft.id)
    const late = () => new Date(Date.now() + NFCE_MAX_EMISSION_DELAY_MS + 60_000)
    // First send: the authority is unreachable.
    await work(tenant, 'timeout-before-accept', late)
    expect((await documents.get(tenant.tenantId, draft.id))?.status).toBe('unknown')
    // Next attempt consults the key first; the authority never saw it, so it is resent
    // and, more than 5 minutes after dhEmi, rejected.
    await work(tenant, 'timeout-before-accept', late)
    const rejected = await documents.get(tenant.tenantId, draft.id)
    expect(rejected?.status).toBe('rejected')
    const observations = await scoped(
      tenant.tenantId,
      (tx) => tx`select observation.observation_kind, observation.outcome
        from fiscal_dispatch_observations observation
        join fiscal_dispatch_commands command on command.tenant_id = observation.tenant_id
          and command.id = observation.command_id
        where command.document_id = ${draft.id} order by observation.observed_at, observation.id`,
    )
    expect(observations.map((row) => [row.observation_kind, row.outcome])).toEqual([
      ['response', 'unknown'],
      ['response', 'rejected'],
    ])
    const events = (await outbox(tenant)).filter(
      (row) => row.event_type === fiscalConsumerDocumentOutcome.type,
    )
    expect(fiscalConsumerDocumentOutcome.payload.parse(events[0]?.payload)).toMatchObject({
      outcome: 'rejected',
      rejectionCode: 'SIMULATED_LATE_EMISSION',
    })

    const intentId = String(
      (
        await scoped(
          tenant.tenantId,
          (tx) => tx`select intent_id from fiscal_documents
        where id = ${draft.id}`,
        )
      )[0]?.intent_id,
    )
    const successor = await documents.createSuccessor({
      tenantId: tenant.tenantId,
      documentId: draft.id,
      correctedIntentId: intentId,
      idempotencyKey: key(),
      actorId: 'user:cashier',
      reason: 'Reemissão após indisponibilidade da autoridade simulada',
    })
    const reissued = await authorize(tenant, successor.id)
    expect(reissued).toMatchObject({ model: '65', status: 'authorized', revision: 2, number: 2 })
    expect(reissued.accessKey).not.toBe(rejected?.accessKey)
    const live = await scoped(
      tenant.tenantId,
      (tx) => tx`select id from fiscal_documents where intent_id = ${intentId}
        and status = 'authorized'`,
    )
    expect(live).toEqual([{ id: successor.id }])
  })

  it('cancels inside the window, refuses after it and keeps a refused cancellation', async () => {
    const tenant = await seedTenant()
    const cancelled = await authorizeNew(tenant, tenant.consumerId, '65')
    await cancel(tenant, cancelled.id)
    await work(tenant, 'authorized')
    expect((await documents.get(tenant.tenantId, cancelled.id))?.status).toBe('cancelled')
    const cancelEvent = (await outbox(tenant))
      .filter((row) => row.event_type === fiscalConsumerDocumentOutcome.type)
      .map((row) => fiscalConsumerDocumentOutcome.payload.parse(row.payload))
      .find((payload) => payload.outcome === 'cancelled')
    expect(cancelEvent).toMatchObject({ documentId: cancelled.id })

    const refused = await authorizeNew(tenant, tenant.consumerId, '65')
    await cancel(tenant, refused.id)
    await work(tenant, 'rejected')
    expect((await documents.get(tenant.tenantId, refused.id))?.status).toBe('authorized')
    const kept = (await artifacts.list(tenant.tenantId, refused.id))?.artifacts.map(
      (row) => row.kind,
    )
    expect(kept).toEqual(expect.arrayContaining(['signed_xml', 'cancellation_response']))

    const late = await authorizeNew(tenant, tenant.consumerId, '65')
    const afterWindow = new FiscalCancellation(
      url,
      documents,
      artifacts,
      dispatch,
      issuerCredential,
      eventZip,
      EVENT_SCHEMA,
      { cancellationWindowMinutes: WINDOW_MINUTES },
      () => new Date(Date.now() + (WINDOW_MINUTES + 2) * 60_000),
    )
    services.push(afterWindow)
    await expect(
      afterWindow.request({
        tenantId: tenant.tenantId,
        documentId: late.id,
        idempotencyKey: key(),
        actorId: 'user:cashier',
        reason: 'Cancelamento pedido depois do prazo revisado',
      }),
    ).rejects.toBeInstanceOf(CancellationWindowElapsed)
    expect((await documents.get(tenant.tenantId, late.id))?.status).toBe('authorized')
  })
})

async function seedTenant(): Promise<Tenant> {
  const tenantId = randomUUID()
  const establishmentId = randomUUID()
  const consumerId = randomUUID()
  const contributorId = randomUUID()
  const remoteConsumerId = randomUUID()
  const coffeeId = randomUUID()
  await admin`insert into tenants (id) values (${tenantId})`
  for (const [source, fixtures] of [
    [
      approvedPhase41Source(tenantId, { byteSize: 1, storageUri: 'file:///test-only/rtc.zip' }),
      [PHASE41_FIXTURE_ID],
    ],
    [approvedPhase46Source(tenantId), [PHASE46_FIXTURE]],
  ] as const) {
    const imported = await store.importSource(source)
    await store.reviewPackage({
      tenantId,
      packageId: imported.packageId,
      approved: true,
      reviewedBy: 'reviewer:phase46-test',
      reviewedAt: '2026-09-26T12:00:00.000Z',
      interpretation: 'Approved only inside the isolated Phase 46 integration test.',
      fixtureIds: [...fixtures],
    })
    for (const ruleId of imported.ruleIds)
      await store.activateRule({
        tenantId,
        ruleId,
        action: 'activate',
        actorId: 'test:phase46',
        reason: 'Isolated Phase 46 integration fixture',
      })
  }
  const ids = { sale: '', consumer: '' }
  for (const [name, model, operation, fixture, adapter] of [
    ['sale', '55', 'normal-sale', PHASE41_FIXTURE_ID, 'nfe55-simulator-v1'],
    ['consumer', '65', 'consumer-sale', PHASE46_FIXTURE, 'nfce65-simulator-v1'],
  ] as const) {
    const definition = await capabilities.register({
      tenantId,
      model,
      environment: 'simulation',
      establishmentId,
      jurisdictionKind: 'uf',
      jurisdictionCode: 'SP',
      operation,
      adapterVersion: adapter,
      sourceManifestDigest: '6'.repeat(64),
      schemaPackageDigest: DOCUMENT_SCHEMA,
      calculationFixtureId: fixture,
      createdBy: 'test:phase46',
    })
    await capabilities.review({
      tenantId,
      capabilityId: definition.id,
      approved: true,
      reviewedBy: 'reviewer:phase46-test',
      interpretation: 'Test-only authorization of the Phase 46 simulation tuple.',
      reviewedAt: '2026-09-26T12:00:00.000Z',
    })
    await capabilities.change({
      tenantId,
      capabilityId: definition.id,
      action: 'activate_simulated',
      evidenceDigest: '9'.repeat(64),
      actorId: 'test:phase46',
      reason: 'Activate only the isolated Phase 46 test fixture.',
      occurredAt: '2026-09-26T12:01:00.000Z',
    })
    ids[name] = definition.id
  }
  await projections.storeIssuer(tenantId, 1, {
    tenantId,
    revision: 1,
    effectiveFrom: '2026-01-01',
    timezone: 'America/Sao_Paulo',
    company: {
      legalName: 'Torrefação Emissora LTDA',
      tradeName: null,
      taxId: ISSUER,
      stateRegistration: '444555666',
      municipalRegistration: null,
      address: {
        line: 'Rua Um, 1',
        city: 'São Paulo',
        municipalityCode: '3550308',
        state: 'SP',
        postalCode: '01001000',
        country: 'BR',
      },
      baseCurrency: 'BRL',
      fiscalRegime: 'lucro-real',
    },
  })
  const address = (state: string, city: string, municipalityCode: string) => ({
    street: 'Rua das Flores',
    number: '7',
    complement: null,
    district: 'Centro',
    city,
    municipalityCode,
    state,
    postalCode: '01001000',
    country: 'BR',
  })
  for (const party of [
    {
      partyId: consumerId,
      kind: 'person' as const,
      taxId: '12345678909',
      legalName: 'Consumidora Simulada',
      stateRegistration: null,
      taxpayerIndicator: 'non-contributor' as const,
      finalConsumer: true,
      address: address('SP', 'São Paulo', '3550308'),
    },
    {
      partyId: contributorId,
      kind: 'organization' as const,
      taxId: '11222333000181',
      legalName: 'Cliente Contribuinte LTDA',
      stateRegistration: '987654321',
      taxpayerIndicator: 'contributor' as const,
      finalConsumer: false,
      address: address('SP', 'São Paulo', '3550308'),
    },
    {
      partyId: remoteConsumerId,
      kind: 'person' as const,
      taxId: '98765432100',
      legalName: 'Consumidor de Outro Estado',
      stateRegistration: null,
      taxpayerIndicator: 'non-contributor' as const,
      finalConsumer: true,
      address: address('RJ', 'Rio de Janeiro', '3304557'),
    },
  ])
    await projections.storeParty(tenantId, party.partyId, 1, {
      tenantId,
      partyId: party.partyId,
      kind: party.kind,
      legalName: party.legalName,
      tradeName: null,
      taxId: party.taxId,
      revision: 1,
      profile: {
        effectiveFrom: '2026-01-01',
        stateRegistration: party.stateRegistration,
        municipalRegistration: null,
        taxpayerIndicator: party.taxpayerIndicator,
        finalConsumer: party.finalConsumer,
        address: party.address,
      },
    })
  await projections.storeClassification(tenantId, coffeeId, 1, {
    tenantId,
    itemId: coffeeId,
    revision: 1,
    effectiveFrom: '2026-01-01',
    ncm: COFFEE_NCM,
  })
  const profile: Nfe55SimulationProfile = {
    capabilityId: ids.sale,
    issuerAddress: { street: 'Rua Um', number: '1', complement: null, district: 'Centro' },
    consumer: {
      capabilityId: ids.consumer,
      natureOperation: 'Venda a consumidor final',
      presence: '4',
      payment: { indicator: '1', method: '05' },
      cancellationWindowMinutes: WINDOW_MINUTES,
    },
    lineFacts: {
      [coffeeId]: {
        productCode: 'CAFE',
        cfop: '5102',
        unit: 'UN',
        ibsCbsCst: '000',
        ibsCbsClassification: '000001',
      },
    },
  }
  const issuance = new FiscalIssuance(
    url,
    documents,
    projections,
    calculations,
    artifacts,
    dispatch,
    profile,
    issuerCredential,
    documentZip,
    DOCUMENT_SCHEMA,
  )
  const cancellation = new FiscalCancellation(
    url,
    documents,
    artifacts,
    dispatch,
    issuerCredential,
    eventZip,
    EVENT_SCHEMA,
    { cancellationWindowMinutes: WINDOW_MINUTES },
  )
  const letters = new FiscalCorrectionLetters(
    url,
    documents,
    artifacts,
    issuerCredential,
    eventZip,
    EVENT_SCHEMA,
  )
  services.push(issuance, cancellation, letters)
  return {
    tenantId,
    establishmentId,
    consumerId,
    contributorId,
    remoteConsumerId,
    coffeeId,
    capabilities: ids,
    profile,
    issuance,
    cancellation,
    letters,
  }
}

function originEvent(
  tenant: Tenant,
  shipmentId: string,
  customerId: string,
  purpose: 'original' | 'return' = 'original',
) {
  return envelope(tenant.tenantId, 'sales.fiscal-origin.recorded', {
    orderId: randomUUID(),
    originModule: 'sales',
    originDocumentType: 'shipment',
    originId: shipmentId,
    purpose,
    customerId,
    lines: [
      {
        lineId: randomUUID(),
        itemId: tenant.coffeeId,
        quantity: '2',
        description: 'Café torrado em grãos',
        unitPrice: { amount: '5000', currency: 'BRL' },
        lineTotal: { amount: '10000', currency: 'BRL' },
      },
    ],
    total: { amount: '10000', currency: 'BRL' },
  })
}

async function intentOf(tenant: Tenant, shipmentId: string): Promise<string> {
  const [row] = await scoped(
    tenant.tenantId,
    (tx) => tx`select id from fiscal_intents where origin_id = ${shipmentId}
      and purpose = 'original'`,
  )
  return String(row?.id)
}

async function shipmentOf(tenant: Tenant, documentId: string): Promise<string> {
  const [row] = await scoped(
    tenant.tenantId,
    (tx) => tx`select intent.origin_id from fiscal_documents document
      join fiscal_intents intent on intent.tenant_id = document.tenant_id
        and intent.id = document.intent_id
      where document.id = ${documentId}`,
  )
  return String(row?.origin_id)
}

function createDraft(
  tenant: Tenant,
  intentId: string,
  model: '55' | '65',
  idempotencyKey?: string,
) {
  return documents.createDraft({
    tenantId: tenant.tenantId,
    intentId,
    model,
    environment: 'simulation',
    establishmentId: tenant.establishmentId,
    series: 1,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })
}

async function draftFor(tenant: Tenant, customerId: string, model: '55' | '65') {
  const shipmentId = randomUUID()
  expect(await ingress.accept(originEvent(tenant, shipmentId, customerId))).toBe('applied')
  return createDraft(tenant, await intentOf(tenant, shipmentId), model)
}

async function authorizeNew(tenant: Tenant, customerId: string, model: '55' | '65') {
  const draft = await draftFor(tenant, customerId, model)
  return authorize(tenant, draft.id)
}

async function validate(tenant: Tenant, documentId: string) {
  const ready = await readiness.validate({
    tenantId: tenant.tenantId,
    documentId,
    actorId: 'user:cashier',
  })
  expect(ready.supported, JSON.stringify(ready)).toBe(true)
  return ready
}

function issue(tenant: Tenant, documentId: string) {
  return tenant.issuance.issue({
    tenantId: tenant.tenantId,
    documentId,
    idempotencyKey: key(),
    actorId: 'user:cashier',
  })
}

async function authorize(tenant: Tenant, documentId: string) {
  await validate(tenant, documentId)
  await issue(tenant, documentId)
  await work(tenant, 'authorized')
  const document = await documents.get(tenant.tenantId, documentId)
  if (!document) throw new Error('document vanished')
  return document
}

async function work(tenant: Tenant, scenario: SimulatorScenario, now?: () => Date) {
  await new FiscalIssueWorker(
    dispatch,
    artifacts,
    new DeterministicNfe55Simulator(() => scenario),
    0,
    new DeterministicNfce65Simulator(() => scenario, now),
  ).processOne(tenant.tenantId, 'worker:phase46')
}

function cancel(tenant: Tenant, documentId: string) {
  return tenant.cancellation.request({
    tenantId: tenant.tenantId,
    documentId,
    idempotencyKey: key(),
    actorId: 'user:cashier',
    reason: 'Consumidor desistiu da compra no caixa',
  })
}

async function signedXml(tenant: Tenant, documentId: string): Promise<string> {
  const document = await documents.get(tenant.tenantId, documentId)
  const found = await artifacts.get(
    tenant.tenantId,
    documentId,
    'signed_xml',
    String(document?.signedXmlDigest),
  )
  return found.bytes.toString('utf8')
}

function envelope(tenantId: string, eventType: string, payload: unknown) {
  return {
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload,
  }
}

async function outbox(tenant: Tenant) {
  return scoped(
    tenant.tenantId,
    (tx) => tx`select event_type, payload from fiscal_outbox order by created_at, event_id`,
  )
}

function key(): string {
  return `phase46-${randomUUID()}`
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
