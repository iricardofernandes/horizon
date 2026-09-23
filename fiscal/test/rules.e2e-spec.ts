import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { FiscalCalculationInput } from '@horizon/contracts'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { FiscalCalculations } from '../src/calculations'
import { FiscalCapabilities } from '../src/capabilities'
import { FiscalDispatch } from '../src/dispatch'
import { FiscalDocuments } from '../src/documents'
import { FiscalManualOrigins } from '../src/manual-origins'
import { FiscalProjections } from '../src/projections'
import { FiscalRuleStore } from '../src/rule-store'

let container: StartedPostgreSqlContainer
let administrator: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let appUrl: string
let store: FiscalRuleStore
let calculations: FiscalCalculations
let capabilities: FiscalCapabilities
let dispatch: FiscalDispatch

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('horizon_fiscal_rules_test')
    .withUsername('postgres')
    .withPassword('test')
    .start()
  administrator = postgres(container.getConnectionUri(), { max: 1 })
  await administrator.unsafe(
    `CREATE ROLE horizon_owner LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_app LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     REVOKE ALL ON SCHEMA public FROM PUBLIC;
     GRANT USAGE ON SCHEMA public TO horizon_app;
     GRANT USAGE, CREATE ON SCHEMA public TO horizon_owner;`,
    [],
    { prepare: false },
  )
  const migrationUrl = container.getConnectionUri().replace('postgres:test@', 'horizon_owner:test@')
  appUrl = container.getConnectionUri().replace('postgres:test@', 'horizon_app:test@')
  await promisify(execFile)(process.execPath, ['scripts/migrate.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
  })
  app = postgres(appUrl, { max: 2 })
  store = new FiscalRuleStore(appUrl)
  calculations = new FiscalCalculations(appUrl, randomBytes(32), store)
  capabilities = new FiscalCapabilities(appUrl)
  dispatch = new FiscalDispatch(appUrl)
}, 120_000)

afterAll(async () => {
  await Promise.allSettled([
    calculations?.close(),
    capabilities?.close(),
    dispatch?.close(),
    store?.close(),
    app?.end(),
    administrator?.end(),
    container?.stop(),
  ])
})

it('keeps capability definitions inactive until independent review and activation', async () => {
  const tenantId = randomUUID()
  const otherTenantId = randomUUID()
  const establishmentId = randomUUID()
  await administrator`insert into tenants (id) values (${tenantId}), (${otherTenantId})`
  const definition = {
    tenantId,
    model: '55' as const,
    environment: 'simulation' as const,
    establishmentId,
    jurisdictionKind: 'uf' as const,
    jurisdictionCode: 'SP',
    operation: 'normal-sale',
    adapterVersion: 'nfe55-simulator-v1',
    sourceManifestDigest: '6'.repeat(64),
    schemaPackageDigest: 'b'.repeat(64),
    calculationFixtureId: 'rtc-v0057-model55-normal-sale-sp-2026-01',
    createdBy: 'importer:phase42',
  }
  const registered = await capabilities.register(definition)
  expect(await capabilities.register(definition)).toEqual({ ...registered, existing: true })
  expect(await capabilities.listActive(tenantId)).toEqual([])

  const activation = {
    tenantId,
    capabilityId: registered.id,
    action: 'activate_simulated' as const,
    evidenceDigest: 'e'.repeat(64),
    actorId: 'release:phase42',
    reason: 'Activate the reviewed Phase 42 simulator tuple',
    occurredAt: '2026-09-22T15:00:00.000Z',
  }
  await expect(capabilities.change(activation)).rejects.toMatchObject({ code: '23514' })
  await expect(
    capabilities.review({
      tenantId,
      capabilityId: registered.id,
      approved: true,
      reviewedBy: definition.createdBy,
      interpretation: 'Self review must not activate a capability.',
      reviewedAt: '2026-09-22T14:50:00.000Z',
    }),
  ).rejects.toMatchObject({ code: '23514' })
  await capabilities.review({
    tenantId,
    capabilityId: registered.id,
    approved: true,
    reviewedBy: 'reviewer:phase42',
    interpretation: 'Approved only for the exact model-55 SP simulation fixture.',
    reviewedAt: '2026-09-22T14:50:00.000Z',
  })
  const activated = await capabilities.change(activation)
  expect(await capabilities.change(activation)).toEqual({ ...activated, existing: true })
  expect(await capabilities.listActive(tenantId)).toEqual([
    expect.objectContaining({
      id: registered.id,
      status: 'simulated',
      model: '55',
      environment: 'simulation',
      jurisdictionCode: 'SP',
      adapterVersion: 'nfe55-simulator-v1',
      evidenceDigest: 'e'.repeat(64),
    }),
  ])
  expect(await capabilities.listActive(otherTenantId)).toEqual([])

  const competing = await capabilities.register({
    ...definition,
    adapterVersion: 'nfe55-simulator-v2',
    createdBy: 'importer:phase42-v2',
  })
  await capabilities.review({
    tenantId,
    capabilityId: competing.id,
    approved: true,
    reviewedBy: 'reviewer:phase42',
    interpretation: 'A reviewed competing adapter used to verify the uniqueness guard.',
    reviewedAt: '2026-09-22T15:05:00.000Z',
  })
  await expect(
    capabilities.change({
      ...activation,
      capabilityId: competing.id,
      evidenceDigest: 'f'.repeat(64),
      occurredAt: '2026-09-22T15:10:00.000Z',
    }),
  ).rejects.toMatchObject({ code: '23505' })

  await capabilities.change({
    ...activation,
    action: 'deactivate',
    evidenceDigest: 'd'.repeat(64),
    reason: 'Deactivate the first adapter before replacement',
    occurredAt: '2026-09-22T15:15:00.000Z',
  })
  expect(await capabilities.listActive(tenantId)).toEqual([])
  await capabilities.change({
    ...activation,
    capabilityId: competing.id,
    evidenceDigest: 'f'.repeat(64),
    occurredAt: '2026-09-22T15:20:00.000Z',
  })
  expect(await capabilities.listActive(tenantId)).toEqual([
    expect.objectContaining({ id: competing.id, adapterVersion: 'nfe55-simulator-v2' }),
  ])

  await expect(
    administrator`update fiscal_capability_definitions set operation = 'changed'
      where id = ${registered.id}`,
  ).rejects.toThrow('append-only')
})

it('freezes a tenant-owned manual origin and creates one digest-verified draft', async () => {
  const tenantId = randomUUID()
  const otherTenantId = randomUUID()
  const establishmentId = randomUUID()
  const recipientPartyId = randomUUID()
  const itemId = randomUUID()
  const key = randomBytes(32)
  await administrator`insert into tenants (id) values (${tenantId}), (${otherTenantId})`
  const definition = await capabilities.register({
    tenantId,
    model: '55',
    environment: 'simulation',
    establishmentId,
    jurisdictionKind: 'uf',
    jurisdictionCode: 'SP',
    operation: 'normal-sale',
    adapterVersion: 'nfe55-simulator-v1',
    sourceManifestDigest: '6'.repeat(64),
    schemaPackageDigest: 'b'.repeat(64),
    calculationFixtureId: 'rtc-v0057-model55-normal-sale-sp-2026-01',
    createdBy: 'importer:manual-test',
  })
  await administrator`insert into fiscal_capability_reviews (
    id, tenant_id, capability_id, approved, reviewed_by, interpretation, reviewed_at
  ) values (
    ${randomUUID()}, ${tenantId}, ${definition.id}, true, 'reviewer:test',
    'Approved only for the isolated manual-origin integration fixture.',
    '2026-09-22T15:00:00.000Z'
  )`
  await administrator`insert into fiscal_capability_activation_events (
    id, tenant_id, capability_id, action, evidence_digest, actor_id, reason, occurred_at
  ) values (
    ${randomUUID()}, ${tenantId}, ${definition.id}, 'activate_simulated',
    ${'9'.repeat(64)}, 'release:test', 'Activate the isolated manual-origin fixture.',
    '2026-09-22T15:01:00.000Z'
  )`
  const projections = new FiscalProjections(appUrl)
  const documents = new FiscalDocuments(appUrl, key)
  const manual = new FiscalManualOrigins(appUrl, key, projections, capabilities, () => ({
    async catalogItem(requestedId) {
      return { id: requestedId, kind: 'product', name: 'Café torrado em grãos', active: true }
    },
  }))
  try {
    await projections.storeIssuer(tenantId, 1, {
      tenantId,
      revision: 1,
      effectiveFrom: '2026-01-01',
      timezone: 'America/Sao_Paulo',
      company: {
        legalName: 'Emissora Exemplo',
        tradeName: null,
        taxId: '00000000E08G12',
        stateRegistration: '123456789',
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
    await projections.storeParty(tenantId, recipientPartyId, 1, {
      tenantId,
      partyId: recipientPartyId,
      kind: 'organization',
      legalName: 'Destinatária Exemplo',
      tradeName: null,
      taxId: '12345678000195',
      revision: 1,
      profile: {
        effectiveFrom: '2026-01-01',
        stateRegistration: '987654321',
        municipalRegistration: null,
        taxpayerIndicator: 'contributor',
        finalConsumer: false,
        address: {
          street: 'Rua Dois',
          number: '2',
          complement: null,
          district: 'Centro',
          city: 'São Paulo',
          municipalityCode: '3550308',
          state: 'SP',
          postalCode: '01001000',
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
    const request = {
      tenantId,
      idempotencyKey: '00000000000000000000000000000031',
      actorId: 'issuer:test',
      establishmentId,
      issuerProfileRevision: 1,
      recipientPartyId,
      recipientProfileRevision: 1,
      issueDate: '2026-09-22',
      operation: 'normal-sale' as const,
      purpose: 'normal' as const,
      reason: 'Simulação revisada para o cenário aprovado',
      lines: [
        {
          lineId: randomUUID(),
          itemId,
          catalogRevision: 1,
          quantity: '2',
          unitPrice: { amount: '5000', currency: 'BRL' },
        },
      ],
    }
    const origin = await manual.create(request)
    expect(await manual.create(request)).toEqual(origin)
    await expect(
      manual.create({ ...request, reason: 'Outra justificativa para a mesma chave' }),
    ).rejects.toThrow('Conflicting')
    const draft = await documents.createManualDraft({
      tenantId,
      manualOriginId: origin.id,
      establishmentId,
      series: 1,
      idempotencyKey: '00000000000000000000000000000032',
      actorId: 'issuer:test',
    })
    expect((await documents.get(tenantId, draft.id))?.origin).toEqual({
      kind: 'manual',
      manualOriginId: origin.id,
    })
    expect(await documents.readSnapshot(tenantId, draft.id)).toMatchObject({
      originModule: 'fiscal',
      originId: origin.id,
      total: { amount: '10000', currency: 'BRL' },
      lines: [{ description: 'Café torrado em grãos', catalogRevision: 1 }],
    })
    await expect(documents.readSnapshot(otherTenantId, draft.id)).rejects.toThrow('not found')
  } finally {
    await Promise.all([manual.close(), documents.close(), projections.close()])
  }
})

it('requires package approval before activation and keeps activation history immutable', async () => {
  const tenantId = randomUUID()
  const packageId = randomUUID()
  const ruleId = randomUUID()
  await administrator`insert into tenants (id) values (${tenantId})`
  await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    await insertPackage(tx, tenantId, packageId, 'a'.repeat(64))
    await insertRule(tx, tenantId, packageId, ruleId, 1, '2026-01-01', '2027-01-01')
  })

  await expect(
    app.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await activate(tx, tenantId, ruleId, 'activate', 'not reviewed yet')
    }),
  ).rejects.toMatchObject({ code: '23514' })

  await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    await tx`insert into fiscal_package_reviews (
      id, tenant_id, package_id, approved, reviewed_by, reviewed_at, interpretation, fixture_ids
    ) values (
      ${randomUUID()}, ${tenantId}, ${packageId}, true, 'specialist:test', now(),
      'Illustrative fixture only', ${['fixture-1']}
    )`
    await activate(tx, tenantId, ruleId, 'activate', 'approved fixture')
  })

  await expect(
    app.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await activate(tx, tenantId, ruleId, 'activate', 'duplicate activation')
    }),
  ).rejects.toMatchObject({ code: '23505' })

  await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    await activate(tx, tenantId, ruleId, 'deactivate', 'rollback fixture')
  })
  await expect(
    administrator`update fiscal_rule_activation_events set reason = 'rewritten' where rule_id = ${ruleId}`,
  ).rejects.toThrow('append-only')
})

it('rejects equal-scope overlaps, permits adjacent windows and isolates tenants', async () => {
  const tenantId = randomUUID()
  const otherTenantId = randomUUID()
  const packageId = randomUUID()
  await administrator`insert into tenants (id) values (${tenantId}), (${otherTenantId})`
  await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    await insertPackage(tx, tenantId, packageId, 'b'.repeat(64))
    await insertRule(tx, tenantId, packageId, randomUUID(), 1, '2026-01-01', '2026-07-01')
    await insertRule(tx, tenantId, packageId, randomUUID(), 2, '2026-07-01', '2027-01-01')
  })
  await expect(
    app.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await insertRule(tx, tenantId, packageId, randomUUID(), 3, '2026-06-01', '2026-08-01')
    }),
  ).rejects.toMatchObject({ code: '23P01' })

  const visible = await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${otherTenantId}, true)`
    return tx`select id from fiscal_tax_rules where tenant_id = ${tenantId}`
  })
  expect(visible).toEqual([])
})

it('imports exact source bytes idempotently and resolves only reviewed active rules', async () => {
  const tenantId = randomUUID()
  const lineId = randomUUID()
  const itemId = randomUUID()
  const establishmentId = randomUUID()
  await administrator`insert into tenants (id) values (${tenantId})`
  const source = {
    tenantId,
    authority: 'illustrative-fixture',
    sourceUri: 'https://example.invalid/phase41-fixture.json',
    publishedAt: '2026-01-01',
    effectiveFrom: '2026-01-01',
    importedBy: 'importer:test',
    bytes: Buffer.from('{"fixture":"phase41"}'),
    entries: [
      {
        family: 'ncm' as const,
        code: '12345678',
        description: 'Illustrative classification',
        jurisdiction: 'BR',
        effectiveFrom: '2026-01-01',
        sourceLocator: 'fixture:ncm:1',
      },
    ],
    rules: [
      {
        ruleKey: 'illustrative.sale.tax',
        version: 1,
        group: 'legacy' as const,
        code: 'ILLUSTRATIVE_TAX',
        precedence: 'default' as const,
        priority: 0,
        model: '55' as const,
        environment: 'simulation' as const,
        effectiveFrom: '2026-01-01',
        effectiveTo: '2027-01-01',
        rate: { numerator: '1', denominator: '10' },
        formula: 'LINE_NET_TIMES_RATE' as const,
        sourceLocator: 'fixture:rule:1',
      },
    ],
  }
  const imported = await store.importSource(source)
  expect(await store.importSource(source)).toEqual({ ...imported, existing: true })
  expect(
    await store.importSource({
      ...source,
      artifact: {
        digest: imported.packageDigest,
        byteSize: 999,
        storageUri: 'file:///retained/phase41-fixture.json',
        verifiedAt: '2026-09-22T13:19:30.000Z',
      },
    }),
  ).toEqual({ ...imported, existing: true })
  const [retained] = await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    return tx`select artifact_digest, byte_size::integer, storage_uri
      from fiscal_source_artifacts where package_id = ${imported.packageId}`
  })
  expect(retained).toMatchObject({
    artifact_digest: imported.packageDigest,
    byte_size: 999,
    storage_uri: 'file:///retained/phase41-fixture.json',
  })
  await expect(
    administrator`delete from fiscal_source_artifacts where package_id = ${imported.packageId}`,
  ).rejects.toThrow('append-only')
  const changed = await store.importSource({
    ...source,
    bytes: Buffer.from('{"fixture":"changed"}'),
    entries: [],
    rules: [],
  })
  expect(changed.packageId).not.toBe(imported.packageId)

  await expect(
    store.reviewPackage({
      tenantId,
      packageId: imported.packageId,
      approved: true,
      reviewedBy: 'importer:test',
      reviewedAt: '2026-09-21T12:00:00.000Z',
      interpretation: 'Self-review must fail',
      fixtureIds: ['illustrative-1'],
    }),
  ).rejects.toMatchObject({ code: '23514' })
  await store.reviewPackage({
    tenantId,
    packageId: imported.packageId,
    approved: true,
    reviewedBy: 'specialist:test',
    reviewedAt: '2026-09-21T12:00:00.000Z',
    interpretation: 'Illustrative fixture approval only',
    fixtureIds: ['illustrative-1'],
  })
  const ruleId = imported.ruleIds[0]
  if (!ruleId) throw new Error('import did not create a rule')
  await store.activateRule({
    tenantId,
    ruleId,
    action: 'activate',
    actorId: 'admin:test',
    reason: 'illustrative e2e fixture',
  })
  const override = {
    tenantId,
    predecessorRuleId: ruleId,
    proposedDefinition: { rate: { numerator: '2', denominator: '10' } },
    sourceBasisUri: 'https://example.invalid/correction',
    sourceBasisSection: 'fixture:correction:1',
    reason: 'Illustrative correction proposal',
    actorId: 'admin:test',
  }
  const proposed = await store.proposeOverride(override)
  expect(await store.proposeOverride(override)).toEqual(proposed)
  const [proposalCounts] = await administrator`select
    (select count(*)::integer from fiscal_rule_override_proposals
      where tenant_id = ${tenantId}) as proposals,
    (select count(*)::integer from fiscal_tax_rules
      where tenant_id = ${tenantId}) as rules`
  expect(proposalCounts).toMatchObject({ proposals: 1, rules: 1 })
  await expect(
    administrator`update fiscal_rule_override_proposals set actor_id = 'rewritten'
      where id = ${proposed.id}`,
  ).rejects.toThrow('append-only')
  const calculationInput: FiscalCalculationInput = {
    schemaVersion: 1,
    tenantId,
    issuerEstablishmentId: establishmentId,
    model: '55',
    environment: 'simulation',
    operation: 'illustrative-sale',
    purpose: 'normal',
    issuer: { regime: 'normal', stateCode: '35', municipalityCode: '3550308' },
    recipient: {
      regime: 'normal',
      stateCode: '35',
      municipalityCode: '3550308',
      taxpayer: true,
    },
    origin: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
    destination: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
    issueDate: '2026-09-21',
    currency: 'BRL',
    lines: [
      {
        id: lineId,
        itemId,
        quantity: '1',
        unitPrice: '10',
        discount: { amount: '0', currency: 'BRL' },
        charges: { amount: '0', currency: 'BRL' },
        classifications: { ncm: '12345678' },
        taxFacts: {},
      },
    ],
  }
  const resolution = await store.resolve(calculationInput, 2)
  expect(resolution, JSON.stringify(resolution)).toMatchObject({
    supported: true,
    trace: [{ selectedRuleId: ruleId }],
  })
  const calculationLine = calculationInput.lines[0]
  if (!calculationLine) throw new Error('fixture has no calculation line')
  expect(
    await store.resolve(
      {
        ...calculationInput,
        lines: [{ ...calculationLine, classifications: { ncm: '99999999' } }],
      },
      2,
    ),
  ).toMatchObject({
    supported: false,
    code: 'MISSING_CLASSIFICATION',
    missingDimension: 'ncm:99999999',
  })
  const [payload] = await administrator`select source_bytes, byte_size from fiscal_source_payloads
    where tenant_id = ${tenantId} and package_id = ${imported.packageId}`
  expect(Buffer.from(payload?.source_bytes)).toEqual(source.bytes)
  expect(Number(payload?.byte_size)).toBe(source.bytes.length)

  const documentId = randomUUID()
  await insertDraft(administrator, tenantId, documentId, establishmentId)
  const [before] = await administrator`select
    (select count(*)::integer from fiscal_calculations) as calculations,
    (select count(*)::integer from fiscal_document_calculation_bindings) as bindings,
    (select count(*)::integer from fiscal_transitions) as transitions,
    (select count(*)::integer from fiscal_outbox) as outbox,
    (select count(*)::integer from fiscal_number_reservations) as reservations`
  expect((await calculations.preview(calculationInput)).supported).toBe(true)
  const [after] = await administrator`select
    (select count(*)::integer from fiscal_calculations) as calculations,
    (select count(*)::integer from fiscal_document_calculation_bindings) as bindings,
    (select count(*)::integer from fiscal_transitions) as transitions,
    (select count(*)::integer from fiscal_outbox) as outbox,
    (select count(*)::integer from fiscal_number_reservations) as reservations`
  expect(after).toEqual(before)

  const [first, retry] = await Promise.all([
    calculations.validateDocument({
      tenantId,
      documentId,
      actorId: 'issuer:test',
      calculationInput,
    }),
    calculations.validateDocument({
      tenantId,
      documentId,
      actorId: 'issuer:test',
      calculationInput,
    }),
  ])
  expect(first).toEqual(retry)
  expect(first.supported).toBe(true)
  expect(await calculations.get(tenantId, documentId)).toEqual(first)
  expect(await calculations.get(randomUUID(), documentId)).toBeNull()
  expect(await calculations.replay(tenantId, documentId)).toEqual(first)

  const unsupportedDocumentId = randomUUID()
  await insertDraft(administrator, tenantId, unsupportedDocumentId, establishmentId)
  const unsupported = await calculations.validateDocument({
    tenantId,
    documentId: unsupportedDocumentId,
    actorId: 'issuer:test',
    calculationInput: {
      ...calculationInput,
      lines: [{ ...calculationLine, classifications: { ncm: '99999999' } }],
    },
  })
  expect(unsupported).toMatchObject({ supported: false, code: 'MISSING_CLASSIFICATION' })
  const [unsupportedDocument] = await administrator`select document.status,
    (select count(*)::integer from fiscal_calculations calculation
      where calculation.tenant_id = document.tenant_id
        and calculation.document_id = document.id) as calculation_count
    from fiscal_documents document where document.id = ${unsupportedDocumentId}`
  expect(unsupportedDocument).toMatchObject({ status: 'draft', calculation_count: 0 })

  const successorSource = {
    ...source,
    bytes: Buffer.from('{"fixture":"phase41-successor"}'),
    publishedAt: '2026-12-01',
    effectiveFrom: '2027-01-01',
    entries: [
      {
        family: 'ncm' as const,
        code: '12345678',
        description: 'Illustrative successor classification',
        effectiveFrom: '2027-01-01',
        sourceLocator: 'fixture:ncm:successor',
      },
    ],
    rules: [
      {
        ruleKey: 'illustrative.sale.tax',
        version: 2,
        group: 'legacy' as const,
        code: 'ILLUSTRATIVE_TAX',
        precedence: 'default' as const,
        priority: 0,
        model: '55' as const,
        environment: 'simulation' as const,
        effectiveFrom: '2027-01-01',
        effectiveTo: '2028-01-01',
        rate: { numerator: '2', denominator: '10' },
        formula: 'LINE_NET_TIMES_RATE' as const,
        sourceLocator: 'fixture:rule:successor',
      },
    ],
  }
  const successor = await store.importSource(successorSource)
  await store.reviewPackage({
    tenantId,
    packageId: successor.packageId,
    approved: true,
    reviewedBy: 'specialist:test',
    reviewedAt: '2026-12-15T12:00:00.000Z',
    interpretation: 'Illustrative successor fixture approval only',
    fixtureIds: ['illustrative-successor'],
  })
  const successorRuleId = successor.ruleIds[0]
  if (!successorRuleId) throw new Error('successor import did not create a rule')
  await store.activateRule({
    tenantId,
    ruleId: successorRuleId,
    action: 'activate',
    actorId: 'admin:test',
    reason: 'illustrative successor fixture',
  })
  expect(await calculations.replay(tenantId, documentId)).toEqual(first)
  const [locked] = await administrator`select document.status, calculation.input_ciphertext,
    calculation.result_digest from fiscal_documents document
    join fiscal_document_calculation_bindings binding
      on binding.tenant_id = document.tenant_id and binding.document_id = document.id
    join fiscal_calculations calculation
      on calculation.tenant_id = binding.tenant_id and calculation.id = binding.calculation_id
    where document.tenant_id = ${tenantId} and document.id = ${documentId}`
  expect(locked?.status).toBe('ready')
  expect(Buffer.from(locked?.input_ciphertext).toString()).not.toContain(lineId)
  if (first.supported) expect(locked?.result_digest).toBe(first.resultDigest)
  await expect(
    administrator`update fiscal_calculations set actor_id = 'rewritten' where document_id = ${documentId}`,
  ).rejects.toThrow('append-only')

  const unboundDocumentId = randomUUID()
  await insertDraft(administrator, tenantId, unboundDocumentId, establishmentId)
  await expect(
    app.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await tx`update fiscal_documents set status = 'ready'
        where tenant_id = ${tenantId} and id = ${unboundDocumentId}`
    }),
  ).rejects.toThrow('requires a supported calculation')
})

it('queues one issuance, leases it once and safely reclaims an expired worker lease', async () => {
  const tenantId = randomUUID()
  const documentId = randomUUID()
  const establishmentId = randomUUID()
  await administrator`insert into tenants (id) values (${tenantId})`
  await insertDraft(administrator, tenantId, documentId, establishmentId)
  await bindTestCalculation(administrator, tenantId, documentId)
  await administrator`update fiscal_documents set status = 'ready' where id = ${documentId}`
  const command = {
    tenantId,
    documentId,
    idempotencyKey: 'phase42-queue-issuance-0001',
    requestDigest: '1'.repeat(64),
    artifactDigest: '2'.repeat(64),
    actorId: 'issuer:test',
  }
  await expect(dispatch.queueIssuance(command)).rejects.toThrow('active capability')
  await bindTestIssuance(
    administrator,
    tenantId,
    documentId,
    establishmentId,
    command.artifactDigest,
  )
  const queued = await dispatch.queueIssuance(command)
  expect(queued).toMatchObject({ status: 'queued', existing: false })
  expect(await dispatch.queueIssuance(command)).toEqual({ ...queued, existing: true })
  await expect(
    dispatch.queueIssuance({ ...command, requestDigest: '3'.repeat(64) }),
  ).rejects.toThrow('Conflicting Fiscal dispatch idempotency key')

  const [first, competing] = await Promise.all([
    dispatch.claim({ tenantId, workerId: 'worker:first', leaseMilliseconds: 1_000 }),
    dispatch.claim({ tenantId, workerId: 'worker:second', leaseMilliseconds: 1_000 }),
  ])
  expect([first, competing].filter(Boolean)).toHaveLength(1)
  const lease = first ?? competing
  if (!lease) throw new Error('Expected a dispatch lease')
  expect(lease).toMatchObject({ commandId: queued.commandId, attemptCount: 1 })
  const [submitted] =
    await administrator`select status from fiscal_documents where id = ${documentId}`
  expect(submitted?.status).toBe('submitted')
  await expect(dispatch.complete(tenantId, queued.commandId, 'worker:other')).rejects.toThrow(
    'not owned',
  )
  await administrator`update fiscal_dispatch_jobs set lease_until = now() - interval '1 second'
    where tenant_id = ${tenantId} and command_id = ${queued.commandId}`
  await expect(
    dispatch.complete(
      tenantId,
      queued.commandId,
      lease === first ? 'worker:first' : 'worker:second',
    ),
  ).rejects.toThrow('not owned')
  const reclaimed = await dispatch.claim({
    tenantId,
    workerId: 'worker:restarted',
    leaseMilliseconds: 30_000,
  })
  expect(reclaimed).toMatchObject({ commandId: queued.commandId, attemptCount: 2 })
  await dispatch.recordObservation({
    tenantId,
    commandId: queued.commandId,
    workerId: 'worker:restarted',
    observationKind: 'consultation',
    outcome: 'unknown',
    providerCorrelation: null,
    responseDigest: 'a'.repeat(64),
    protocolDigest: null,
  })
  const [unknown] =
    await administrator`select status from fiscal_documents where id = ${documentId}`
  expect(unknown?.status).toBe('unknown')
  await dispatch.retry(tenantId, queued.commandId, 'worker:restarted', new Date(0))
  const resolution = await dispatch.claim({
    tenantId,
    workerId: 'worker:resolver',
    leaseMilliseconds: 30_000,
  })
  expect(resolution).toMatchObject({ commandId: queued.commandId, attemptCount: 3 })
  await dispatch.recordObservation({
    tenantId,
    commandId: queued.commandId,
    workerId: 'worker:resolver',
    observationKind: 'consultation',
    outcome: 'authorized',
    providerCorrelation: 'simulation:authorized',
    responseDigest: 'b'.repeat(64),
    protocolDigest: 'c'.repeat(64),
  })
  const [authorized] =
    await administrator`select status from fiscal_documents where id = ${documentId}`
  expect(authorized?.status).toBe('authorized')
  expect(await dispatch.claim({ tenantId, workerId: 'worker:idle' })).toBeNull()
  const [counts] = await administrator`select
      (select count(*)::integer from fiscal_number_reservations
        where tenant_id = ${tenantId} and document_id = ${documentId}) as numbers,
      (select count(*)::integer from fiscal_dispatch_commands
        where tenant_id = ${tenantId} and document_id = ${documentId}) as commands`
  expect(counts).toMatchObject({ numbers: 1, commands: 1 })
})

it('resolves an uncertain issuance through an explicit query without a second submission', async () => {
  const tenantId = randomUUID()
  const documentId = randomUUID()
  const establishmentId = randomUUID()
  await administrator`insert into tenants (id) values (${tenantId})`
  await insertDraft(administrator, tenantId, documentId, establishmentId)
  await bindTestCalculation(administrator, tenantId, documentId)
  await administrator`update fiscal_documents set status = 'ready' where id = ${documentId}`
  await bindTestIssuance(administrator, tenantId, documentId, establishmentId, '2'.repeat(64))
  const issuance = await dispatch.queueIssuance({
    tenantId,
    documentId,
    idempotencyKey: 'phase42-query-issuance-0001',
    requestDigest: '1'.repeat(64),
    artifactDigest: '2'.repeat(64),
    actorId: 'issuer:test',
  })
  await dispatch.claim({ tenantId, workerId: 'worker:original' })
  await dispatch.recordObservation({
    tenantId,
    commandId: issuance.commandId,
    workerId: 'worker:original',
    observationKind: 'response',
    outcome: 'unknown',
    providerCorrelation: null,
    responseDigest: 'a'.repeat(64),
    protocolDigest: null,
  })
  const queryInput = {
    tenantId,
    documentId,
    idempotencyKey: 'phase42-status-query-0001',
    requestDigest: '3'.repeat(64),
    actorId: 'issuer:test',
  }
  const [query, concurrentQuery] = await Promise.all([
    dispatch.queueStatusQuery(queryInput),
    dispatch.queueStatusQuery(queryInput),
  ])
  expect(concurrentQuery.commandId).toBe(query.commandId)
  expect(await dispatch.queueStatusQuery(queryInput)).toEqual({ ...query, existing: true })
  const lease = await dispatch.claim({ tenantId, workerId: 'worker:query' })
  expect(lease).toMatchObject({
    kind: 'status_query',
    commandId: query.commandId,
    issuanceCommandId: issuance.commandId,
    requestDigest: '1'.repeat(64),
    artifactDigest: '2'.repeat(64),
  })
  await dispatch.recordObservation({
    tenantId,
    commandId: query.commandId,
    workerId: 'worker:query',
    observationKind: 'consultation',
    outcome: 'authorized',
    providerCorrelation: 'simulation:query',
    responseDigest: 'b'.repeat(64),
    protocolDigest: 'c'.repeat(64),
  })
  expect(
    (await administrator`select status from fiscal_documents where id = ${documentId}`)[0]?.status,
  ).toBe('authorized')
  expect(await dispatch.claim({ tenantId, workerId: 'worker:idle' })).toBeNull()
  const [evidence] = await administrator`select
      (select count(*)::integer from fiscal_number_reservations
        where tenant_id = ${tenantId} and document_id = ${documentId}) as numbers,
      (select count(*)::integer from fiscal_dispatch_commands
        where tenant_id = ${tenantId} and document_id = ${documentId} and kind = 'issuance') as submissions`
  expect(evidence).toMatchObject({ numbers: 1, submissions: 1 })
})

it('queues an immutable cancellation and resolves uncertainty through the original event identity', async () => {
  const tenantId = randomUUID()
  const documentId = randomUUID()
  const establishmentId = randomUUID()
  const eventDigest = 'd'.repeat(64)
  await administrator`insert into tenants (id) values (${tenantId})`
  await insertDraft(administrator, tenantId, documentId, establishmentId)
  await bindTestCalculation(administrator, tenantId, documentId)
  await administrator`update fiscal_documents set status = 'ready' where id = ${documentId}`
  await bindTestIssuance(administrator, tenantId, documentId, establishmentId, '2'.repeat(64))
  const issuance = await dispatch.queueIssuance({
    tenantId,
    documentId,
    idempotencyKey: '00000000000000000000000000000012',
    requestDigest: '1'.repeat(64),
    artifactDigest: '2'.repeat(64),
    actorId: 'issuer:test',
  })
  await dispatch.claim({ tenantId, workerId: 'worker:issue' })
  await dispatch.recordObservation({
    tenantId,
    commandId: issuance.commandId,
    workerId: 'worker:issue',
    observationKind: 'response',
    outcome: 'authorized',
    providerCorrelation: 'simulation:authorized',
    responseDigest: 'a'.repeat(64),
    protocolDigest: 'b'.repeat(64),
  })
  await administrator`insert into fiscal_artifacts (
      id, tenant_id, document_id, kind, purpose, object_key, digest,
      size_bytes, media_type, source_schema
    ) values (
      ${randomUUID()}, ${tenantId}, ${documentId}, 'cancellation_request',
      'cancellation_request', ${`${tenantId}/${documentId}/cancellation_request/${eventDigest}`},
      ${eventDigest}, 1, 'application/xml', 'PL_010d_v1.03:test'
    )`
  const command = {
    tenantId,
    documentId,
    idempotencyKey: '00000000000000000000000000000013',
    requestDigest: 'c'.repeat(64),
    artifactDigest: eventDigest,
    actorId: 'issuer:test',
  }
  const [cancellation, concurrentCancellation] = await Promise.all([
    dispatch.queueCancellation(command),
    dispatch.queueCancellation(command),
  ])
  expect(cancellation).toMatchObject({ kind: 'cancellation', status: 'cancellation_pending' })
  expect(concurrentCancellation.commandId).toBe(cancellation.commandId)
  expect(await dispatch.queueCancellation(command)).toEqual({ ...cancellation, existing: true })
  const first = await dispatch.claim({ tenantId, workerId: 'worker:cancel' })
  expect(first).toMatchObject({ kind: 'cancellation', artifactDigest: eventDigest })
  await dispatch.recordObservation({
    tenantId,
    commandId: cancellation.commandId,
    workerId: 'worker:cancel',
    observationKind: 'response',
    outcome: 'unknown',
    providerCorrelation: null,
    responseDigest: 'e'.repeat(64),
    protocolDigest: null,
  })
  await dispatch.retry(
    tenantId,
    cancellation.commandId,
    'worker:cancel',
    new Date(Date.now() + 60_000),
  )
  const queryCommand = {
    tenantId,
    documentId,
    idempotencyKey: 'phase42-cancel-query-0001',
    requestDigest: 'f'.repeat(64),
    actorId: 'issuer:test',
  }
  const [query, concurrentQuery] = await Promise.all([
    dispatch.queueCancellationQuery(queryCommand),
    dispatch.queueCancellationQuery(queryCommand),
  ])
  expect(concurrentQuery.commandId).toBe(query.commandId)
  const queryLease = await dispatch.claim({ tenantId, workerId: 'worker:query' })
  expect(queryLease).toMatchObject({
    kind: 'cancellation_query',
    commandId: query.commandId,
    cancellationCommandId: cancellation.commandId,
    requestDigest: 'c'.repeat(64),
    artifactDigest: eventDigest,
  })
  await dispatch.recordObservation({
    tenantId,
    commandId: query.commandId,
    workerId: 'worker:query',
    observationKind: 'consultation',
    outcome: 'cancelled',
    providerCorrelation: 'simulation:cancelled',
    responseDigest: '4'.repeat(64),
    protocolDigest: '5'.repeat(64),
  })
  expect(
    (await administrator`select status from fiscal_documents where id = ${documentId}`)[0]?.status,
  ).toBe('cancelled')
  expect(await dispatch.claim({ tenantId, workerId: 'worker:idle' })).toBeNull()
  expect(
    (
      await administrator`select state from fiscal_dispatch_jobs
      where tenant_id = ${tenantId} and command_id = ${cancellation.commandId}`
    )[0]?.state,
  ).toBe('done')
  const events = await administrator`select event_type, payload from fiscal_outbox
    where tenant_id = ${tenantId} order by created_at, event_id`
  expect(events.map((event) => event.event_type).sort()).toEqual([
    'fiscal.document.simulation-authorized',
    'fiscal.document.simulation-cancelled',
  ])
  expect(
    events.find((event) => event.event_type === 'fiscal.document.simulation-cancelled')?.payload,
  ).toMatchObject({
    documentId,
    environment: 'simulation',
    simulated: true,
  })
  const documents = new FiscalDocuments(appUrl, randomBytes(32))
  try {
    expect(
      (await documents.timeline(tenantId, documentId))?.transitions.map((item) => item.to),
    ).toEqual([
      'queued',
      'submitted',
      'authorized',
      'cancellation_pending',
      'cancellation_unknown',
      'cancelled',
    ])
  } finally {
    await documents.close()
  }
})

it('isolates manual origins and dispatch evidence while allowing worker lease updates', async () => {
  const tenantId = randomUUID()
  const otherTenantId = randomUUID()
  const documentId = randomUUID()
  const originId = randomUUID()
  const commandId = randomUUID()
  const observationId = randomUUID()
  await administrator`insert into tenants (id) values (${tenantId}), (${otherTenantId})`
  await insertDraft(administrator, tenantId, documentId, randomUUID())
  const [root] = await administrator`select root_document_id, revision
    from fiscal_documents where id = ${documentId}`
  expect(root).toMatchObject({ root_document_id: documentId, revision: 1 })

  await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    await tx`insert into fiscal_manual_origins (
      id, tenant_id, establishment_id, issuer_profile_revision,
      recipient_party_id, recipient_profile_revision, issue_date,
      actor_id, reason_digest, payload_ciphertext, payload_digest
    ) values (
      ${originId}, ${tenantId}, ${randomUUID()}, 1, ${randomUUID()}, 1,
      '2026-09-22', 'issuer:test', ${'a'.repeat(64)},
      ${Buffer.from('encrypted-manual-origin')}, ${'b'.repeat(64)}
    )`
    await tx`insert into fiscal_dispatch_commands (
      id, tenant_id, document_id, kind, idempotency_key, request_digest, actor_id
    ) values (
      ${commandId}, ${tenantId}, ${documentId}, 'issuance',
      'phase42-issuance-0001', ${'c'.repeat(64)}, 'issuer:test'
    )`
    await tx`insert into fiscal_dispatch_jobs (tenant_id, command_id)
      values (${tenantId}, ${commandId})`
    await tx`update fiscal_dispatch_jobs set state = 'leased',
      lease_owner = 'worker:test', lease_until = now() + interval '1 minute',
      attempt_count = 1 where tenant_id = ${tenantId} and command_id = ${commandId}`
    await tx`insert into fiscal_dispatch_observations (
      id, tenant_id, command_id, observation_kind, outcome, response_digest
    ) values (
      ${observationId}, ${tenantId}, ${commandId}, 'response', 'unknown', ${'d'.repeat(64)}
    )`
  })

  await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${otherTenantId}, true)`
    expect(await tx`select id from fiscal_manual_origins where id = ${originId}`).toHaveLength(0)
    expect(await tx`select id from fiscal_dispatch_commands where id = ${commandId}`).toHaveLength(
      0,
    )
    expect(
      await tx`select id from fiscal_dispatch_observations where id = ${observationId}`,
    ).toHaveLength(0)
  })
  await expect(
    administrator`update fiscal_manual_origins set actor_id = 'rewritten' where id = ${originId}`,
  ).rejects.toThrow('append-only')
  await expect(
    administrator`update fiscal_dispatch_commands set actor_id = 'rewritten' where id = ${commandId}`,
  ).rejects.toThrow('append-only')
  await expect(
    administrator`update fiscal_dispatch_observations set outcome = 'authorized'
      where id = ${observationId}`,
  ).rejects.toThrow('append-only')
  await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    await tx`insert into fiscal_dispatch_observations (
      id, tenant_id, command_id, observation_kind, outcome, response_digest
    ) values (
      ${randomUUID()}, ${tenantId}, ${commandId}, 'consultation', 'authorized', ${'e'.repeat(64)}
    )`
  })
  await expect(
    app.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await tx`insert into fiscal_dispatch_observations (
        id, tenant_id, command_id, observation_kind, outcome, response_digest
      ) values (
        ${randomUUID()}, ${tenantId}, ${commandId}, 'callback', 'rejected', ${'f'.repeat(64)}
      )`
    }),
  ).rejects.toMatchObject({ code: '23505' })
})

async function insertPackage(
  sql: postgres.TransactionSql,
  tenantId: string,
  packageId: string,
  digest: string,
) {
  await sql`insert into fiscal_source_packages (
    id, tenant_id, authority, source_uri, package_digest, published_at, effective_from
  ) values (
    ${packageId}, ${tenantId}, 'fixture', 'https://example.invalid/fixture', ${digest},
    '2026-01-01', '2026-01-01'
  )`
  const bytes = Buffer.from('illustrative fixture')
  await sql`insert into fiscal_source_payloads (
    tenant_id, package_id, source_bytes, byte_size, imported_by
  ) values (${tenantId}, ${packageId}, ${bytes}, ${bytes.length}, 'importer:test')`
}

async function insertRule(
  sql: postgres.TransactionSql,
  tenantId: string,
  packageId: string,
  ruleId: string,
  version: number,
  effectiveFrom: string,
  effectiveTo: string,
) {
  await sql`insert into fiscal_tax_rules (
    id, tenant_id, package_id, rule_key, version, component_group, component_code,
    precedence, priority, model, environment, effective_from, effective_to,
    rate_numerator, rate_denominator, formula, source_locator, definition_digest
  ) values (
    ${ruleId}, ${tenantId}, ${packageId}, 'illustrative.tax', ${version}, 'legacy',
    'ILLUSTRATIVE_TAX', 'default', 0, '55', 'simulation', ${effectiveFrom},
    ${effectiveTo}, '1', '10', 'LINE_NET_TIMES_RATE', 'fixture-only', ${'c'.repeat(64)}
  )`
}

async function activate(
  sql: postgres.TransactionSql,
  tenantId: string,
  ruleId: string,
  action: 'activate' | 'deactivate',
  reason: string,
) {
  await sql`insert into fiscal_rule_activation_events (
    id, tenant_id, rule_id, action, actor_id, reason
  ) values (${randomUUID()}, ${tenantId}, ${ruleId}, ${action}, 'admin:test', ${reason})`
}

async function insertDraft(
  sql: ReturnType<typeof postgres>,
  tenantId: string,
  documentId: string,
  establishmentId: string,
) {
  const intentId = randomUUID()
  await sql`insert into fiscal_intents (
    id, tenant_id, origin_module, origin_document_type, origin_id, purpose,
    order_id, customer_id, payload_digest
  ) values (
    ${intentId}, ${tenantId}, 'sales', 'shipment', ${randomUUID()}, 'original',
    ${randomUUID()}, ${randomUUID()}, ${'d'.repeat(64)}
  )`
  await sql`insert into fiscal_documents (
    id, tenant_id, intent_id, model, environment, establishment_id, series,
    snapshot_digest, snapshot_ciphertext
  ) values (
    ${documentId}, ${tenantId}, ${intentId}, '55', 'simulation', ${establishmentId}, 1,
    ${'d'.repeat(64)}, ${Buffer.from('encrypted-placeholder')}
  )`
}

async function bindTestCalculation(
  sql: ReturnType<typeof postgres>,
  tenantId: string,
  documentId: string,
) {
  const calculationId = randomUUID()
  await sql`insert into fiscal_calculations (
    id, tenant_id, document_id, input_ciphertext, input_digest, resolved_rules,
    rules_digest, result_bytes, result_digest, explanation_template_version,
    explanation_text, rule_version_ids, package_digests, supported, actor_id
  ) values (
    ${calculationId}, ${tenantId}, ${documentId}, ${Buffer.from('encrypted-test-input')},
    ${'4'.repeat(64)}, ${sql.json({ fixture: true })}, ${'5'.repeat(64)},
    ${Buffer.from('{"fixture":true}')}, ${'6'.repeat(64)}, 'test-v1',
    'Phase 42 queue fixture', ${[]}, ${[]}, true, 'test:phase42'
  )`
  await sql`insert into fiscal_document_calculation_bindings
    (tenant_id, document_id, calculation_id)
    values (${tenantId}, ${documentId}, ${calculationId})`
}

async function bindTestIssuance(
  sql: ReturnType<typeof postgres>,
  tenantId: string,
  documentId: string,
  establishmentId: string,
  signedXmlDigest: string,
) {
  const capabilityId = randomUUID()
  await sql`insert into fiscal_capability_definitions (
    id, tenant_id, model, environment, establishment_id, jurisdiction_kind,
    jurisdiction_code, operation, adapter_version, source_manifest_digest,
    schema_package_digest, calculation_fixture_id, created_by
  ) values (
    ${capabilityId}, ${tenantId}, '55', 'simulation', ${establishmentId}, 'uf', 'SP',
    'normal-sale', 'nfe55-simulator-v1', ${'7'.repeat(64)}, ${'8'.repeat(64)},
    'phase42-queue-fixture', 'importer:test'
  )`
  await sql`insert into fiscal_capability_reviews (
    id, tenant_id, capability_id, approved, reviewed_by, interpretation, reviewed_at
  ) values (
    ${randomUUID()}, ${tenantId}, ${capabilityId}, true, 'reviewer:test',
    'Approved only for the Phase 42 queue fixture.', '2026-09-22T15:00:00.000Z'
  )`
  await sql`insert into fiscal_capability_activation_events (
    id, tenant_id, capability_id, action, evidence_digest, actor_id, reason, occurred_at
  ) values (
    ${randomUUID()}, ${tenantId}, ${capabilityId}, 'activate_simulated', ${'9'.repeat(64)},
    'release:test', 'Activate only the Phase 42 queue fixture.', '2026-09-22T15:01:00.000Z'
  )`
  await sql`insert into fiscal_document_issuance_bindings (
    tenant_id, document_id, capability_id, environment, access_key,
    reconciliation_digest, signed_xml_digest
  ) values (
    ${tenantId}, ${documentId}, ${capabilityId}, 'simulation',
    '35260900000000E08G12550010000000011123456783', ${'a'.repeat(64)},
    ${signedXmlDigest}
  )`
}
