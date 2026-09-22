import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { FiscalCalculationInput } from '@horizon/contracts'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { FiscalCalculations } from '../src/calculations'
import { FiscalRuleStore } from '../src/rule-store'

let container: StartedPostgreSqlContainer
let administrator: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let appUrl: string
let store: FiscalRuleStore
let calculations: FiscalCalculations

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
}, 120_000)

afterAll(async () => {
  await Promise.allSettled([
    calculations?.close(),
    store?.close(),
    app?.end(),
    administrator?.end(),
    container?.stop(),
  ])
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
  expect(locked?.status).toBe('validated')
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
      await tx`update fiscal_documents set status = 'validated'
        where tenant_id = ${tenantId} and id = ${unboundDocumentId}`
    }),
  ).rejects.toThrow('requires a supported calculation')
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
