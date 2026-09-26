import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { EncryptedFiscalArtifactStore, LocalObjectStore } from '../src/artifact-store'
import { FiscalArtifacts } from '../src/artifacts'
import { FiscalCalculations } from '../src/calculations'
import { FiscalCapabilities } from '../src/capabilities'
import { FiscalDocuments } from '../src/documents'
import { FiscalEstablishmentCredentials } from '../src/establishment-credentials'
import { HomologationCancellation } from '../src/homologation-cancellation'
import { HomologationDanfe } from '../src/homologation-danfe'
import { HomologationExchangeLedger } from '../src/homologation-exchange-ledger'
import {
  HomologationExchangeRunner,
  UncertainSefazOutcomeError,
} from '../src/homologation-exchange-runner'
import { HomologationIssuance } from '../src/homologation-issuance'
import { HomologationObservations } from '../src/homologation-observations'
import { HomologationRecovery } from '../src/homologation-recovery'
import { HomologationRestoreVerifier } from '../src/homologation-restore-verifier'
import { FiscalIngress } from '../src/ingress'
import type { HomologationCredential } from '../src/nfe55/homologation-credential'
import type { BrazilianUf } from '../src/nfe55/jurisdiction'
import { SefazNfe55HomologationAdapter, type SefazOperationMap } from '../src/nfe55/sefaz-adapter'
import {
  authorizerForUf,
  homologationAdapterVersion,
  SEFAZ_HOMOLOGATION_ENDPOINTS,
  type SefazAuthorizer,
} from '../src/nfe55/sefaz-authorizers'
import { type SefazEmulatorScenario, SefazHomologationEmulator } from '../src/nfe55/sefaz-emulator'
import { SefazResponseSchemaValidator } from '../src/nfe55/sefaz-response-schema'
import { SefazHomologationTransport } from '../src/nfe55/sefaz-transport'
import { loadSefazTrustAnchor, type SefazTrustAnchor } from '../src/nfe55/sefaz-trust-anchor'
import { approvedPhase41Source } from '../src/phase41-approved-scenario'
import { FiscalProjections } from '../src/projections'
import { FiscalReadiness } from '../src/readiness'
import { FiscalRuleStore } from '../src/rule-store'

const run = promisify(execFile)
const nfeSchemaDigest = 'b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998'
const documentResponseDigest = '2e925939a228aaf785be9fe7d6315f2da94d3a10036d54ffb7c1273aa7502b05'
const consultationResponseDigest =
  '45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b'
const author = 'author:phase43-drill'
const reviewer = 'reviewer:phase43-drill'
const operations: SefazOperationMap = {
  wsdlDigest: createHash('sha256').update('emulated-nfe-4.00-wsdl').digest('hex'),
  authorization: {
    operation: 'nfeAutorizacaoLote',
    operationNamespace: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4',
  },
  receipt: {
    operation: 'nfeRetAutorizacaoLote',
    operationNamespace: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRetAutorizacao4',
  },
  protocol: {
    operation: 'nfeConsultaNF',
    operationNamespace: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4',
  },
  status: {
    operation: 'nfeStatusServicoNF',
    operationNamespace: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4',
  },
  event: {
    operation: 'nfeRecepcaoEvento',
    operationNamespace: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4',
  },
}

let container: StartedPostgreSqlContainer
let admin: ReturnType<typeof postgres>
let url: string
let directory: string
let masterKey: Buffer
let trust: SefazTrustAnchor
let artifacts: FiscalArtifacts
let ledger: HomologationExchangeLedger
let capabilities: FiscalCapabilities
let documents: FiscalDocuments
let projections: FiscalProjections
let calculations: FiscalCalculations
let rules: FiscalRuleStore
let credentials: FiscalEstablishmentCredentials
let observations: HomologationObservations
let ingress: FiscalIngress
let responseSchemas: SefazResponseSchemaValidator
const scenarios = new Map<string, SefazEmulatorScenario>()
const emulators = new Map<
  SefazAuthorizer,
  { emulator: SefazHomologationEmulator; route: { host: '127.0.0.1'; port: number } }
>()

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('horizon_phase43_drill_test')
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
  directory = await mkdtemp(join(tmpdir(), 'horizon-phase43-drill-'))
  masterKey = randomBytes(32)
  const server = await emulatorCertificates(directory)
  trust = await loadSefazTrustAnchor({
    certificatePath: join(directory, 'root.pem'),
    expectedFingerprint: server.rootFingerprint,
  })
  for (const authorizer of ['SP', 'SVRS'] as const) {
    const emulator = new SefazHomologationEmulator(
      authorizer,
      server,
      (accessKey) => scenarios.get(accessKey) ?? 'authorize',
    )
    emulators.set(authorizer, { emulator, route: await emulator.listen() })
  }
  artifacts = new FiscalArtifacts(
    url,
    new EncryptedFiscalArtifactStore(new LocalObjectStore(join(directory, 'objects')), masterKey),
  )
  ledger = new HomologationExchangeLedger(url, artifacts)
  capabilities = new FiscalCapabilities(url)
  documents = new FiscalDocuments(url, masterKey)
  projections = new FiscalProjections(url)
  rules = new FiscalRuleStore(url)
  calculations = new FiscalCalculations(url, masterKey, rules)
  credentials = new FiscalEstablishmentCredentials(url, masterKey)
  observations = new HomologationObservations(url)
  ingress = new FiscalIngress(url, masterKey)
  responseSchemas = new SefazResponseSchemaValidator(
    {
      archive: await readFile(new URL('../fixtures/official/pl-009p-v1.03.zip', import.meta.url)),
      digest: documentResponseDigest,
    },
    {
      archive: await readFile(new URL('../fixtures/official/pl-010d-v1.03.zip', import.meta.url)),
      digest: consultationResponseDigest,
    },
  )
}, 180_000)

afterAll(async () => {
  await Promise.allSettled([
    ...[...emulators.values()].map(({ emulator }) => emulator.close()),
    ledger?.close(),
    capabilities?.close(),
    documents?.close(),
    projections?.close(),
    calculations?.close(),
    rules?.close(),
    credentials?.close(),
    observations?.close(),
    ingress?.close(),
    artifacts?.close(),
  ])
  await Promise.allSettled([admin?.end(), container?.stop()])
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('runs one tenant per authorizer with its own A1, UF and municipality', async () => {
  const sp = await provision({
    uf: 'SP',
    municipalityCode: '3550308',
    city: 'São Paulo',
    taxId: '12345678000195',
  })
  const rj = await provision({
    uf: 'RJ',
    municipalityCode: '3304557',
    city: 'Rio de Janeiro',
    taxId: '98765432000100',
  })
  expect(sp.adapter).toMatchObject({ authorizer: 'SP', adapterVersion: 'nfe55-sp-homologation-v1' })
  expect(rj.adapter).toMatchObject({
    authorizer: 'SVRS',
    adapterVersion: 'nfe55-svrs-homologation-v1',
  })

  for (const tenant of [sp, rj]) {
    const document = await newDocument(tenant)
    const grantId = await grant(tenant, document)
    const context = await ledger.drillScope(tenant.tenantId, document, grantId)
    expect(context).toMatchObject({ jurisdiction: tenant.uf, authority: 'emulated' })
    const status = await tenant.runner.execute(
      {
        tenantId: tenant.tenantId,
        documentId: document,
        exchangeId: randomUUID(),
        parentExchangeId: null,
        actorId: 'operator:drill',
        workerId: 'worker:drill',
        ...(await ledger.drillContext(tenant.tenantId, document, grantId)),
      },
      await tenant.adapter.prepare({ service: 'status' }),
    )
    expect(status.statusCode).toBe('107')

    const prepared = await issue(tenant, document, grantId)
    const signed = await signedXml(tenant, document)
    expect(signed).toContain(`<cUF>${tenant.ufCode}</cUF>`)
    expect(signed).toContain(`<cMunFG>${tenant.municipalityCode}</cMunFG>`)
    expect(signed).toContain(`<CNPJ>${tenant.taxId}</CNPJ>`)
    expect(prepared.accessKey.slice(0, 2)).toBe(tenant.ufCode)
    expect(prepared.accessKey.slice(6, 20)).toBe(tenant.taxId)

    const received = await tenant.runner.resume(
      {
        tenantId: tenant.tenantId,
        exchangeId: prepared.exchangeId,
        actorId: 'operator:drill',
        workerId: 'worker:drill',
      },
      operations,
    )
    expect(received).toMatchObject({ statusCode: '103' })
    expect(received.receipt).toMatch(new RegExp(`^${tenant.ufCode}\\d{13}$`))
    const authorized = await consult(tenant, document)
    expect(authorized).toMatchObject({
      service: 'receipt',
      statusCode: '104',
      documentStatusCode: '100',
    })
    expect(await decisions(tenant, document)).toEqual(['available', 'pending', 'authorized'])

    const renderer = new HomologationDanfe(url, artifacts)
    const danfe = await renderer.render(tenant.tenantId, document).finally(() => renderer.close())
    expect(danfe.digest).toMatch(/^[0-9a-f]{64}$/)

    const cancellation = await new HomologationCancellation(
      ledger,
      capabilities,
      tenant.adapter,
      tenant.credential,
      await readFile(new URL('../fixtures/official/pl-010d-v1.03.zip', import.meta.url)),
    ).prepare({
      tenantId: tenant.tenantId,
      documentId: document,
      exchangeId: randomUUID(),
      actorId: 'operator:drill',
      reason: 'Cancelamento do ensaio de homologacao emulado',
      occurredAt: `${new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 19)}-03:00`,
    })
    const cancelled = await tenant.runner.resume(
      {
        tenantId: tenant.tenantId,
        exchangeId: cancellation.exchangeId,
        actorId: 'operator:drill',
        workerId: 'worker:drill',
      },
      operations,
    )
    expect(cancelled).toMatchObject({ statusCode: '128', eventStatusCode: '135' })
    expect(await decisions(tenant, document)).toEqual([
      'available',
      'pending',
      'authorized',
      'cancelled',
    ])
    const emulator = emulatorFor(tenant.authorizer)
    expect(emulator.sent('authorization', prepared.accessKey)).toBe(1)
    const verifier = new HomologationRestoreVerifier(url, artifacts, observations)
    try {
      expect((await verifier.verify(tenant.tenantId, document)).exchanges).toBe(4)
    } finally {
      await verifier.close()
    }
  }
  expect(emulatorFor('SVRS').requests.every((request) => request.clientTaxId === rj.taxId)).toBe(
    true,
  )
  expect(emulatorFor('SP').requests.every((request) => request.clientTaxId === sp.taxId)).toBe(true)
})

it('keeps rejection final and never resends a lost or unavailable authorization', async () => {
  const tenant = await provision({
    uf: 'RJ',
    municipalityCode: '3304557',
    city: 'Rio de Janeiro',
    taxId: '98765432000100',
  })
  const emulator = emulatorFor('SVRS')

  const rejectedDocument = await newDocument(tenant)
  const rejected = await issue(
    tenant,
    rejectedDocument,
    await grant(tenant, rejectedDocument),
    'reject',
  )
  await resume(tenant, rejected.exchangeId)
  expect(await consult(tenant, rejectedDocument)).toMatchObject({ documentStatusCode: '225' })
  expect(await decisions(tenant, rejectedDocument)).toEqual(['pending', 'rejected'])
  await expect(consult(tenant, rejectedDocument)).rejects.toThrow('terminal homologation decision')

  const unknownDocument = await newDocument(tenant)
  const unreviewed = await issue(
    tenant,
    unknownDocument,
    await grant(tenant, unknownDocument),
    'unreviewed',
  )
  await resume(tenant, unreviewed.exchangeId)
  expect(await consult(tenant, unknownDocument)).toMatchObject({ documentStatusCode: '539' })
  expect(await decisions(tenant, unknownDocument)).toEqual(['pending', 'unknown'])

  const lostDocument = await newDocument(tenant)
  const lost = await issue(tenant, lostDocument, await grant(tenant, lostDocument), 'lose-response')
  await expect(resume(tenant, lost.exchangeId)).rejects.toBeInstanceOf(UncertainSefazOutcomeError)
  await expect(resume(tenant, lost.exchangeId)).rejects.toBeInstanceOf(UncertainSefazOutcomeError)
  expect(emulator.sent('authorization', lost.accessKey)).toBe(1)
  expect(await consult(tenant, lostDocument)).toMatchObject({
    service: 'protocol',
    statusCode: '100',
    documentStatusCode: '100',
  })
  expect((await observations.list(tenant.tenantId, lostDocument)).map((row) => row.stage)).toEqual([
    'send_started',
    'observed',
  ])

  const outageDocument = await newDocument(tenant)
  const outage = await issue(
    tenant,
    outageDocument,
    await grant(tenant, outageDocument),
    'unavailable',
  )
  await expect(resume(tenant, outage.exchangeId)).rejects.toBeInstanceOf(UncertainSefazOutcomeError)
  expect(await consult(tenant, outageDocument)).toMatchObject({ statusCode: '217' })
  expect(await decisions(tenant, outageDocument)).toEqual(['unknown'])
  await expect(resume(tenant, outage.exchangeId)).rejects.toBeInstanceOf(UncertainSefazOutcomeError)
  expect(emulator.sent('authorization', outage.accessKey)).toBe(1)
})

it('refuses crossed UFs, official claims over the emulator and emulated activation evidence', async () => {
  const sp = await provision({
    uf: 'SP',
    municipalityCode: '3550308',
    city: 'São Paulo',
    taxId: '12345678000195',
  })
  const rj = await provision({
    uf: 'RJ',
    municipalityCode: '3304557',
    city: 'Rio de Janeiro',
    taxId: '98765432000100',
  })
  expect(
    () => new HomologationExchangeRunner(ledger, sp.transport, rj.adapter, responseSchemas),
  ).toThrow('authorizer differs')
  await expect(
    capabilities.register({
      ...capabilityDefinition(sp.tenantId, sp.establishmentId, 'SP'),
      jurisdictionCode: 'XX',
    }),
  ).rejects.toThrow()

  const document = await newDocument(sp)
  const grantId = await grant(sp, document)
  const prepared = await issue(sp, document, grantId)
  const official = new HomologationExchangeRunner(
    ledger,
    new SefazHomologationTransport(SEFAZ_HOMOLOGATION_ENDPOINTS.SP, sp.credential, trust),
    sp.adapter,
    responseSchemas,
  )
  await expect(
    official.resume(
      {
        tenantId: sp.tenantId,
        exchangeId: prepared.exchangeId,
        actorId: 'operator:drill',
        workerId: 'worker:drill',
      },
      operations,
    ),
  ).rejects.toThrow('differs from the approved drill grant')
  await resume(sp, prepared.exchangeId)
  const consultation = await consult(sp, document)
  expect(consultation.documentStatusCode).toBe('100')
  const cancellation = await new HomologationCancellation(
    ledger,
    capabilities,
    sp.adapter,
    sp.credential,
    await readFile(new URL('../fixtures/official/pl-010d-v1.03.zip', import.meta.url)),
  ).prepare({
    tenantId: sp.tenantId,
    documentId: document,
    exchangeId: randomUUID(),
    actorId: 'operator:drill',
    reason: 'Cancelamento do ensaio de homologacao emulado',
    occurredAt: `${new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 19)}-03:00`,
  })
  await resume(sp, cancellation.exchangeId)
  const exchanges = await observations.list(sp.tenantId, document)
  const [authorization, receipt, event] = exchanges
  if (!authorization || !receipt || !event) throw new Error('Drill exchanges are incomplete')
  await expect(
    capabilities.recordHomologationEvidence({
      tenantId: sp.tenantId,
      capabilityId: sp.capabilityId,
      sourceManifestDigest: sp.sourceManifestDigest,
      endpointSetDigest: sp.transport.endpointSetDigest,
      certificateFingerprint: sp.credential.fingerprint,
      roundTripDigest: 'e'.repeat(64),
      authorizationExchangeId: authorization.exchangeId,
      consultationExchangeId: receipt.exchangeId,
      cancellationExchangeId: event.exchangeId,
      reviewedBy: reviewer,
      reviewedAt: new Date().toISOString(),
    }),
  ).rejects.toThrow('lacks linked authorized consultation and cancellation')
  expect(await ledger.nextPreparedForActive(sp.tenantId)).toBeNull()
})

type Tenant = Awaited<ReturnType<typeof provision>>

async function provision(input: {
  uf: BrazilianUf
  municipalityCode: string
  city: string
  taxId: string
}) {
  const tenantId = randomUUID()
  const establishmentId = randomUUID()
  const recipientPartyId = randomUUID()
  const itemId = randomUUID()
  const authorizer = authorizerForUf(input.uf)
  const ufCode = input.municipalityCode.slice(0, 2)
  const fixtureId = `rtc-v0057-model55-normal-sale-${input.uf.toLowerCase()}-homologation-2026`
  const sourceManifestDigest = createHash('sha256').update(`manifest:${input.uf}`).digest('hex')
  await admin`insert into tenants (id) values (${tenantId})`
  await credentials.upload({
    tenantId,
    establishmentId,
    pfx: await a1(input.taxId),
    password: 'test-only-password',
    actorId: 'admin:fiscal',
  })
  const credential: HomologationCredential = await credentials.active(tenantId, establishmentId)

  const approved = approvedPhase41Source(tenantId, {
    byteSize: 1,
    storageUri: 'file:///test-only/rtc-v0057.zip',
  })
  const imported = await rules.importSource({
    ...approved,
    bytes: Buffer.from(`${approved.bytes.toString()}\n${input.uf}-homologation`),
    rules: approved.rules.map((rule) => ({
      ...rule,
      environment: 'homologation' as const,
      originState: ufCode,
      destinationState: ufCode,
    })),
  })
  await rules.reviewPackage({
    tenantId,
    packageId: imported.packageId,
    approved: true,
    reviewedBy: reviewer,
    reviewedAt: new Date().toISOString(),
    interpretation: `RTC 2026 reference rates, national, scoped to ${input.uf} for the emulated drill.`,
    fixtureIds: [fixtureId],
  })
  for (const ruleId of imported.ruleIds)
    await rules.activateRule({
      tenantId,
      ruleId,
      action: 'activate',
      actorId: author,
      reason: 'Emulated homologation drill rule activation',
    })

  const capability = await capabilities.register({
    ...capabilityDefinition(tenantId, establishmentId, input.uf),
    sourceManifestDigest,
    calculationFixtureId: fixtureId,
  })
  await capabilities.review({
    tenantId,
    capabilityId: capability.id,
    approved: true,
    reviewedBy: reviewer,
    interpretation: `Emulated ${authorizer} homologation drill for ${input.uf}.`,
    reviewedAt: new Date().toISOString(),
  })
  for (const [name, digest] of [
    ['pl-009p-v1.03.zip', documentResponseDigest],
    ['pl-010d-v1.03.zip', consultationResponseDigest],
  ] as const)
    await retainReviewedSource(tenantId, name, digest, fixtureId)
  await capabilities.approveHomologationResponseSchemas({
    tenantId,
    capabilityId: capability.id,
    sourceManifestDigest,
    documentSchemaDigest: documentResponseDigest,
    consultationSchemaDigest: consultationResponseDigest,
    reviewedBy: reviewer,
  })
  await capabilities.approveHomologationEventSchema({
    tenantId,
    capabilityId: capability.id,
    sourceManifestDigest,
    schemaDigest: consultationResponseDigest,
    reviewedBy: reviewer,
  })
  await capabilities.approveHomologationCalculation({
    tenantId,
    capabilityId: capability.id,
    sourceManifestDigest,
    calculationFixtureId: fixtureId,
    packageDigests: [imported.packageDigest],
    reviewedBy: reviewer,
  })
  await capabilities.registerHomologationIssuanceProfile({
    tenantId,
    capabilityId: capability.id,
    sourceManifestDigest,
    reviewedBy: reviewer,
    profile: {
      capabilityId: capability.id,
      issuerAddress: { street: 'Rua Fiscal', number: '42', complement: null, district: 'Centro' },
      lineFacts: {
        [itemId]: {
          productCode: 'CAFE-001',
          cfop: '5102',
          unit: 'UN',
          ibsCbsCst: '000',
          ibsCbsClassification: '000001',
        },
      },
    },
  })
  await capabilities.registerHomologationNumberRange({
    tenantId,
    capabilityId: capability.id,
    establishmentId,
    series: 1,
    firstNumber: 1,
    lastNumber: 1000,
    evidenceDigest: createHash('sha256').update(`range:${tenantId}`).digest('hex'),
    reviewedBy: reviewer,
  })

  await projections.storeIssuer(tenantId, 1, {
    tenantId,
    revision: 1,
    effectiveFrom: '2026-01-01',
    timezone: 'America/Sao_Paulo',
    company: {
      legalName: `Emissora ${input.uf} Ltda`,
      tradeName: null,
      taxId: input.taxId,
      stateRegistration: '12345678',
      municipalRegistration: null,
      address: {
        line: 'Rua Fiscal, 42',
        city: input.city,
        municipalityCode: input.municipalityCode,
        state: input.uf,
        postalCode: '20000000',
        country: 'BR',
      },
      baseCurrency: 'BRL',
      fiscalRegime: 'lucro-real',
    },
  })
  await projections.storeParty(tenantId, recipientPartyId, 1, {
    tenantId,
    partyId: recipientPartyId,
    kind: 'organization',
    legalName: `Destinataria ${input.uf} Ltda`,
    tradeName: null,
    taxId: '11222333000181',
    revision: 1,
    profile: {
      effectiveFrom: '2026-01-01',
      stateRegistration: '87654321',
      municipalRegistration: null,
      taxpayerIndicator: 'contributor',
      finalConsumer: false,
      address: {
        street: 'Rua Dois',
        number: '2',
        complement: null,
        district: 'Centro',
        city: input.city,
        municipalityCode: input.municipalityCode,
        state: input.uf,
        postalCode: '20000000',
        country: 'BR',
      },
    },
  })
  await projections.storeClassification(tenantId, itemId, 1, {
    tenantId,
    itemId,
    revision: 1,
    effectiveFrom: '2026-01-01',
    ncm: '09012100',
  })

  const adapter = new SefazNfe55HomologationAdapter(credential, operations, input.uf)
  const route = emulators.get(authorizer)?.route
  if (!route) throw new Error(`No emulator for ${authorizer}`)
  const transport = new SefazHomologationTransport(
    SEFAZ_HOMOLOGATION_ENDPOINTS[authorizer],
    credential,
    trust,
    { emulatorRoute: route },
  )
  expect(adapter.adapterVersion).toBe(homologationAdapterVersion(authorizer))
  return {
    ...input,
    tenantId,
    establishmentId,
    recipientPartyId,
    itemId,
    authorizer,
    ufCode,
    capabilityId: capability.id,
    sourceManifestDigest,
    credential,
    adapter,
    transport,
    runner: new HomologationExchangeRunner(ledger, transport, adapter, responseSchemas),
  }
}

function capabilityDefinition(tenantId: string, establishmentId: string, uf: string) {
  const authorizer = authorizerForUf(uf as BrazilianUf)
  return {
    tenantId,
    model: '55' as const,
    environment: 'homologation' as const,
    establishmentId,
    jurisdictionKind: 'uf' as const,
    jurisdictionCode: uf,
    operation: 'normal-sale',
    adapterVersion: homologationAdapterVersion(authorizer),
    sourceManifestDigest: 'd'.repeat(64),
    schemaPackageDigest: nfeSchemaDigest,
    calculationFixtureId: 'unused',
    createdBy: author,
  }
}

async function retainReviewedSource(
  tenantId: string,
  file: string,
  digest: string,
  fixtureId: string,
): Promise<void> {
  const bytes = await readFile(new URL(`../fixtures/official/${file}`, import.meta.url))
  const packageId = randomUUID()
  await admin`insert into fiscal_source_packages (
    id, tenant_id, authority, source_uri, package_digest, published_at, effective_from
  ) values (
    ${packageId}, ${tenantId}, 'ENCAT / Portal Nacional da NF-e',
    ${`https://www.nfe.fazenda.gov.br/portal/${file}`}, ${digest}, '2026-01-01', '2026-01-01'
  )`
  await admin`insert into fiscal_source_payloads (
    tenant_id, package_id, source_bytes, byte_size, imported_by
  ) values (${tenantId}, ${packageId}, ${bytes}, ${bytes.length}, ${author})`
  await admin`insert into fiscal_package_reviews (
    id, tenant_id, package_id, approved, reviewed_by, reviewed_at, interpretation, fixture_ids
  ) values (
    ${randomUUID()}, ${tenantId}, ${packageId}, true, ${reviewer}, now(),
    'Response and event schemas reviewed for the emulated drill', ${[fixtureId]}
  )`
}

async function newDocument(tenant: Tenant): Promise<string> {
  const shipmentId = randomUUID()
  const lineId = randomUUID()
  expect(
    await ingress.accept({
      eventId: randomUUID(),
      eventType: 'sales.fiscal-origin.recorded',
      eventVersion: 2,
      occurredAt: new Date().toISOString(),
      tenantId: tenant.tenantId,
      traceId: 'd'.repeat(32),
      payload: {
        orderId: randomUUID(),
        originModule: 'sales',
        originDocumentType: 'shipment',
        originId: shipmentId,
        purpose: 'original',
        customerId: tenant.recipientPartyId,
        lines: [
          {
            lineId,
            itemId: tenant.itemId,
            quantity: '2',
            description: 'Café torrado em grãos',
            unitPrice: { amount: '2500', currency: 'BRL' },
            lineTotal: { amount: '5000', currency: 'BRL' },
          },
        ],
        total: { amount: '5000', currency: 'BRL' },
        orderVersion: 2,
        originRevision: 1,
        warehouseId: randomUUID(),
        establishmentId: tenant.establishmentId,
        preDispatch: true,
      },
    }),
  ).toBe('applied')
  const [intent] = await admin`select id from fiscal_intents
    where tenant_id = ${tenant.tenantId} and origin_id = ${shipmentId}`
  const draft = await documents.createHomologationDraft({
    tenantId: tenant.tenantId,
    intentId: String(intent?.id),
    model: '55',
    environment: 'homologation',
    establishmentId: tenant.establishmentId,
    series: 1,
  })
  return draft.id
}

async function grant(tenant: Tenant, documentId: string): Promise<string> {
  const grantId = randomUUID()
  await ledger.grantDrill({
    tenantId: tenant.tenantId,
    documentId,
    grantId,
    capabilityId: tenant.capabilityId,
    endpointDigest: tenant.transport.endpointSetDigest,
    wsdlDigest: operations.wsdlDigest,
    certificateFingerprint: tenant.credential.fingerprint,
    issuedBy: 'operator:drill',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    authority: 'emulated',
  })
  const readiness = await new FiscalReadiness(
    documents,
    projections,
    capabilities,
    calculations,
  ).validateHomologationDrill({
    tenantId: tenant.tenantId,
    documentId,
    drillGrantId: grantId,
    actorId: 'operator:drill',
  })
  expect(readiness.supported, JSON.stringify(readiness)).toBe(true)
  return grantId
}

async function issue(
  tenant: Tenant,
  documentId: string,
  drillGrantId: string,
  scenario: SefazEmulatorScenario = 'authorize',
) {
  const issuance = new HomologationIssuance(
    url,
    documents,
    projections,
    calculations,
    capabilities,
    ledger,
    tenant.adapter,
    tenant.credential,
    await readFile(new URL('../fixtures/official/pl-010f-v1.04.zip', import.meta.url)),
    nfeSchemaDigest,
  )
  try {
    const prepared = await issuance.prepare({
      tenantId: tenant.tenantId,
      documentId,
      drillGrantId,
      exchangeId: randomUUID(),
      actorId: 'operator:drill',
    })
    scenarios.set(prepared.accessKey, scenario)
    return prepared
  } finally {
    await issuance.close()
  }
}

function resume(tenant: Tenant, exchangeId: string) {
  return tenant.runner.resume(
    { tenantId: tenant.tenantId, exchangeId, actorId: 'operator:drill', workerId: 'worker:drill' },
    operations,
  )
}

async function consult(tenant: Tenant, documentId: string) {
  const target = await ledger.recoveryTarget(tenant.tenantId, documentId)
  const parent = await ledger.loadPrepared(
    tenant.tenantId,
    target.parentExchangeId,
    operations,
    'operator:drill',
  )
  return new HomologationRecovery(ledger, tenant.adapter, tenant.runner).consult({
    ...parent.input,
    documentId,
    exchangeId: randomUUID(),
    actorId: 'operator:drill',
    workerId: 'worker:drill',
  })
}

async function decisions(tenant: Tenant, documentId: string): Promise<string[]> {
  return (await observations.list(tenant.tenantId, documentId))
    .filter((row) => row.stage === 'observed')
    .map((row) => row.decision)
}

async function signedXml(tenant: Tenant, documentId: string): Promise<string> {
  const [binding] = await admin`select signed_xml_digest
    from fiscal_homologation_authorization_bindings
    where tenant_id = ${tenant.tenantId} and document_id = ${documentId}`
  const artifact = await artifacts.getV2(
    tenant.tenantId,
    documentId,
    'homologation_request',
    String(binding?.signed_xml_digest),
  )
  return artifact.bytes.toString('utf8')
}

function emulatorFor(authorizer: SefazAuthorizer): SefazHomologationEmulator {
  const entry = emulators.get(authorizer)
  if (!entry) throw new Error(`No emulator for ${authorizer}`)
  return entry.emulator
}

async function a1(taxId: string): Promise<Buffer> {
  const base = join(directory, `a1-${taxId}`)
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    `/CN=Horizon A1 ${taxId} Test Only`,
    '-addext',
    `subjectAltName=otherName:2.16.76.1.3.3;PRINTABLE:${taxId}`,
    '-keyout',
    `${base}.key`,
    '-out',
    `${base}.pem`,
  ])
  await run('openssl', [
    'pkcs12',
    '-export',
    '-inkey',
    `${base}.key`,
    '-in',
    `${base}.pem`,
    '-out',
    `${base}.pfx`,
    '-passout',
    'pass:test-only-password',
  ])
  return readFile(`${base}.pfx`)
}

/** A test-only root signs one server certificate naming the official authorizer hosts. */
async function emulatorCertificates(root: string) {
  const hosts = (['SP', 'SVRS'] as const).map(
    (authorizer) => new URL(SEFAZ_HOMOLOGATION_ENDPOINTS[authorizer].authorization).hostname,
  )
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=Horizon SEFAZ Emulator Root Test Only',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout',
    join(root, 'root.key'),
    '-out',
    join(root, 'root.pem'),
  ])
  await run('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=Horizon SEFAZ Emulator',
    '-keyout',
    join(root, 'server.key'),
    '-out',
    join(root, 'server.csr'),
  ])
  await writeFile(
    join(root, 'server.ext'),
    `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(',')}\n` +
      'basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n',
  )
  await run('openssl', [
    'x509',
    '-req',
    '-in',
    join(root, 'server.csr'),
    '-CA',
    join(root, 'root.pem'),
    '-CAkey',
    join(root, 'root.key'),
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    join(root, 'server.ext'),
    '-out',
    join(root, 'server.pem'),
  ])
  const { stdout } = await run('openssl', [
    'x509',
    '-in',
    join(root, 'root.pem'),
    '-noout',
    '-fingerprint',
    '-sha256',
  ])
  return {
    certificate: await readFile(join(root, 'server.pem')),
    privateKey: await readFile(join(root, 'server.key')),
    rootFingerprint: stdout.split('=')[1]?.replaceAll(':', '').trim().toLowerCase() ?? '',
  }
}
