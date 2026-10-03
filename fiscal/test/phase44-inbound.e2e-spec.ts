import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  auditQuerySchema,
  fiscalInboundImportSchema,
  fiscalInboundMatched,
} from '@horizon/contracts'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { EncryptedFiscalArtifactStore, LocalObjectStore } from '../src/artifact-store'
import { type AuditRow, verifyAuditRows } from '../src/audit'
import { FiscalAuditLog } from '../src/audit-log'
import { FiscalEstimateRecords } from '../src/estimate-records'
import { FiscalInboundImports } from '../src/inbound-imports'
import {
  FiscalInboundReconciliations,
  type InboundReconciliationRequest,
} from '../src/inbound-reconciliations'
import { FiscalIngress } from '../src/ingress'
import type { SimulationCredential } from '../src/nfe55/signature'
import { signNfe55 } from '../src/nfe55/signature'
import { FiscalProjections } from '../src/projections'
import {
  signedSupplierInvoice,
  supplierCredential,
  supplierInvoice,
  withProtocol,
} from './support/inbound-nfe'

const run = promisify(execFile)
const SCHEMA_DIGEST = 'b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998'
const SUPPLIER = '12345678000195'
const BUYER_A = '98765432000100'
const BUYER_B = '11222333000181'
const GRAIN_NCM = '09011110'

let container: StartedPostgreSqlContainer
let admin: ReturnType<typeof postgres>
let url: string
let directory: string
let masterKey: Buffer
let credential: SimulationCredential
let ingress: FiscalIngress
let projections: FiscalProjections
let imports: FiscalInboundImports
let reconciliations: FiscalInboundReconciliations
let estimateRecords: FiscalEstimateRecords

type Tenant = {
  tenantId: string
  supplierId: string
  grainId: string
  sackId: string
  buyer: string
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('horizon_phase44_inbound_test')
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
  directory = await mkdtemp(join(tmpdir(), 'horizon-phase44-'))
  masterKey = randomBytes(32)
  credential = await supplierCredential(directory, SUPPLIER)
  ingress = new FiscalIngress(url, masterKey)
  projections = new FiscalProjections(url, masterKey)
  const store = new EncryptedFiscalArtifactStore(
    new LocalObjectStore(join(directory, 'objects')),
    masterKey,
  )
  const zip = await readFile(new URL('../fixtures/official/pl-010f-v1.04.zip', import.meta.url))
  imports = new FiscalInboundImports(url, masterKey, store, projections, {
    zip,
    digest: SCHEMA_DIGEST,
  })
  reconciliations = new FiscalInboundReconciliations(url, masterKey, projections)
  estimateRecords = new FiscalEstimateRecords(url)
}, 180_000)

afterAll(async () => {
  await Promise.allSettled([
    ingress?.close(),
    projections?.close(),
    imports?.close(),
    reconciliations?.close(),
    estimateRecords?.close(),
    admin?.end(),
  ])
  await container?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('reconciles an XML imported after its receipt once, whatever is replayed or reimported', async () => {
  const tenant = await seedTenant(BUYER_A)
  const orderLine = randomUUID()
  await approveOrder(tenant, randomUUID(), [
    { lineId: orderLine, itemId: tenant.grainId, quantity: '10' },
  ])
  const receiptId = randomUUID()
  const orderId = randomUUID()
  const receipt = await receive(tenant, orderId, receiptId, [
    { lineId: orderLine, itemId: tenant.grainId, quantity: '6', unitPrice: '1000' },
  ])
  const titleId = randomUUID()
  const payable = await postPayable(tenant, titleId, receiptId, '6000')

  const signed = signedSupplierInvoice(invoice(tenant, 101, '6', '10.00'), credential)
  const created = await imports.import({
    tenantId: tenant.tenantId,
    xml: signed,
    actorId: 'user:r',
  })
  expect(created.outcome).toBe('created')
  expect(
    await imports.import({ tenantId: tenant.tenantId, xml: signed, actorId: 'user:r' }),
  ).toEqual({ outcome: 'duplicate', importId: created.importId, conflictId: null })
  expect(
    await imports.import({
      tenantId: tenant.tenantId,
      xml: withProtocol(signed),
      actorId: 'user:r',
    }),
  ).toMatchObject({ outcome: 'duplicate', importId: created.importId })

  const view = fiscalInboundImportSchema.parse(await imports.get(tenant.tenantId, created.importId))
  expect(view).toMatchObject({
    status: 'open',
    supplierPartyId: tenant.supplierId,
    invoiceTotal: '60.00',
    supplier: { candidatePartyIds: [tenant.supplierId], legalName: 'Fornecedor de Teste LTDA' },
    verification: { signature: 'valid-unanchored', authorityStatus: 'unverified' },
  })
  expect(view.proposals).toEqual([
    {
      lineNumber: 1,
      basis: 'ncm',
      allocations: [{ receiptId, receiptLineId: orderLine, quantity: '6' }],
    },
  ])
  expect((await imports.xml(tenant.tenantId, created.importId))?.bytes.equals(signed)).toBe(true)

  const request: InboundReconciliationRequest = {
    supplierPartyId: tenant.supplierId,
    lines: [{ lineNumber: 1, receiptId, receiptLineId: orderLine, quantity: '6' }],
    unmatchedLines: [],
    rememberMappings: true,
  }
  const key = `reconcile-${randomUUID()}`
  const first = await reconciliations.reconcile({
    tenantId: tenant.tenantId,
    importId: created.importId,
    request,
    idempotencyKey: key,
    actorId: 'user:r',
  })
  expect(first.replayed).toBe(false)
  expect(first.reconciliation).toMatchObject({
    decision: 'matched',
    overrideReason: null,
    receipts: [{ receiptId, orderId }],
    payableTitleIds: [titleId],
    comparison: { clean: true, invoicedValueMinor: '6000', expectedValueMinor: '6000' },
  })
  const again = await reconciliations.reconcile({
    tenantId: tenant.tenantId,
    importId: created.importId,
    request,
    idempotencyKey: key,
    actorId: 'user:r',
  })
  expect(again).toEqual({ reconciliation: first.reconciliation, replayed: true })
  await expect(
    reconciliations.reconcile({
      tenantId: tenant.tenantId,
      importId: created.importId,
      request: { ...request, rememberMappings: false },
      idempotencyKey: key,
      actorId: 'user:r',
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  await expect(
    reconciliations.reconcile({
      tenantId: tenant.tenantId,
      importId: created.importId,
      request,
      idempotencyKey: `reconcile-${randomUUID()}`,
      actorId: 'user:r',
    }),
  ).rejects.toMatchObject({ code: 'ALREADY_RECONCILED' })

  expect(await ingress.accept(receipt)).toBe('duplicate')
  expect(await ingress.accept(payable)).toBe('duplicate')
  const counts = await scoped(tenant.tenantId, async (tx) => {
    const [row] = await tx`select
      (select count(*) from fiscal_purchase_receipts)::int as receipts,
      (select count(*) from fiscal_purchase_payables)::int as payables,
      (select count(*) from fiscal_inbound_documents)::int as documents,
      (select count(*) from fiscal_inbound_reconciliations)::int as reconciliations,
      (select count(*) from fiscal_supplier_item_mappings)::int as mappings`
    const outbox = await tx`select event_type, payload from fiscal_outbox`
    return { ...row, outbox }
  })
  expect(counts).toMatchObject({
    receipts: 1,
    payables: 1,
    documents: 1,
    reconciliations: 1,
    mappings: 1,
  })
  expect(counts.outbox.map((row) => row.event_type)).toEqual(['fiscal.inbound.matched'])
  expect(fiscalInboundMatched.payload.parse(counts.outbox[0]?.payload)).toMatchObject({
    importId: created.importId,
    decision: 'matched',
    payableTitleIds: [titleId],
  })
  expect(JSON.stringify(counts.outbox[0]?.payload)).not.toContain('<')
  expect((await imports.get(tenant.tenantId, created.importId))?.status).toBe('reconciled')
  const audit = await scoped(
    tenant.tenantId,
    (tx) => tx<AuditRow[]>`select * from fiscal_audit_entries order by sequence`,
  )
  expect(verifyAuditRows(audit)).toBe(true)
  expect(audit.map((row) => row.action)).toEqual([
    'fiscal.inbound.imported',
    'fiscal.inbound.reconciled',
  ])
  // Phase 68: the audit read endpoint judges each page, and a tampered row shows as broken.
  const log = new FiscalAuditLog(url)
  try {
    const read = (query: Record<string, string>) =>
      log.page(tenant.tenantId, auditQuerySchema.parse(query))
    const intact = await read({})
    expect(intact.chain).toEqual({ status: 'intact', checked: 2, broken: [] })
    expect(intact.data.map((entry) => entry.action)).toEqual([
      'fiscal.inbound.reconciled',
      'fiscal.inbound.imported',
    ])
    expect((await read({ action: 'fiscal.inbound.imported' })).chain.status).toBe('intact')
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`
      await tx`update fiscal_audit_entries set actor_id = 'someone-else'
        where tenant_id = ${tenant.tenantId} and sequence = 1`
    })
    expect((await read({})).chain).toMatchObject({ status: 'broken', broken: [1] })
  } finally {
    await log.close()
  }
})

it('matches a partially received order to several invoices and never allocates twice', async () => {
  const tenant = await seedTenant(BUYER_A)
  const orderLine = randomUUID()
  const orderId = randomUUID()
  const first = randomUUID()
  const second = randomUUID()
  await receive(tenant, orderId, first, [
    { lineId: orderLine, itemId: tenant.grainId, quantity: '6', unitPrice: '1000' },
  ])
  await receive(tenant, orderId, second, [
    { lineId: orderLine, itemId: tenant.grainId, quantity: '4', unitPrice: '1000' },
  ])
  const a = await importInvoice(tenant, 201, '6', '10.00')
  const b = await importInvoice(tenant, 202, '4', '10.00')
  const c = await importInvoice(tenant, 203, '6', '10.00')

  const proposalA = (await imports.get(tenant.tenantId, a))?.proposals[0]
  expect(proposalA?.allocations).toEqual([
    { receiptId: first, receiptLineId: orderLine, quantity: '6' },
  ])
  await commit(tenant, a, [
    { lineNumber: 1, receiptId: first, receiptLineId: orderLine, quantity: '6' },
  ])
  const proposalB = (await imports.get(tenant.tenantId, b))?.proposals[0]
  expect(proposalB?.allocations).toEqual([
    { receiptId: second, receiptLineId: orderLine, quantity: '4' },
  ])
  expect(
    (await commit(tenant, b, proposalB?.allocations.map((x) => ({ ...x, lineNumber: 1 })) ?? []))
      .receipts,
  ).toEqual([{ receiptId: second, orderId }])

  expect((await imports.get(tenant.tenantId, c))?.proposals[0]).toEqual({
    lineNumber: 1,
    basis: 'none',
    allocations: [],
  })
  await expect(
    commit(tenant, c, [
      { lineNumber: 1, receiptId: first, receiptLineId: orderLine, quantity: '6' },
    ]),
  ).rejects.toMatchObject({ code: 'ALLOCATION_INVALID' })

  const reconciliationId = await scoped(tenant.tenantId, async (tx) => {
    const [row] = await tx`select id from fiscal_inbound_reconciliations where import_id = ${a}`
    return String(row?.id)
  })
  await expect(
    scoped(
      tenant.tenantId,
      (tx) => tx`insert into fiscal_inbound_reconciliation_lines
      (tenant_id, reconciliation_id, line_number, receipt_id, receipt_line_id, quantity)
      values (${tenant.tenantId}, ${reconciliationId}, 2, ${first}, ${orderLine}, 1)`,
    ),
  ).rejects.toThrow('exceeds the received quantity')
})

it('keeps an XML that arrived first open, proposes it later and requires a reason for differences', async () => {
  const tenant = await seedTenant(BUYER_A)
  const importId = await importInvoice(tenant, 301, '5', '11.00')
  const early = await imports.get(tenant.tenantId, importId)
  expect(early).toMatchObject({ status: 'open', proposals: [{ basis: 'none', allocations: [] }] })

  const orderLine = randomUUID()
  const receiptId = randomUUID()
  await receive(tenant, randomUUID(), receiptId, [
    { lineId: orderLine, itemId: tenant.grainId, quantity: '5', unitPrice: '1000' },
  ])
  const titleId = randomUUID()
  await postPayable(tenant, titleId, receiptId, '5000')
  const late = await imports.get(tenant.tenantId, importId)
  expect(late?.proposals[0]?.allocations).toEqual([
    { receiptId, receiptLineId: orderLine, quantity: '5' },
  ])
  const lines = [{ lineNumber: 1, receiptId, receiptLineId: orderLine, quantity: '5' }]
  await expect(commit(tenant, importId, lines)).rejects.toMatchObject({
    code: 'OVERRIDE_REQUIRED',
    comparison: { clean: false, lines: [{ differences: ['value'] }] },
  })
  const kept = await commit(tenant, importId, lines, 'Fornecedor reajustou o preço após o pedido')
  expect(kept).toMatchObject({
    decision: 'overridden',
    overrideReason: 'Fornecedor reajustou o preço após o pedido',
    comparison: { invoicedValueMinor: '5500', expectedValueMinor: '5000' },
  })

  await ingress.accept(
    envelope(tenant.tenantId, 'procurement.receipt.returned', {
      orderId: randomUUID(),
      orderVersion: 1,
      receiptId,
      returnedBy: 'user:warehouse',
      reason: 'Lote com umidade acima do limite',
      warehouseId: randomUUID(),
      remaining: { amount: '5000', currency: 'BRL' },
      remainingInstallments: [],
      lines: [{ lineId: orderLine, itemId: tenant.grainId, quantity: '5' }],
    }),
  )
  await ingress.accept(
    envelope(tenant.tenantId, 'financial.payable.reversed', {
      titleId,
      partyId: tenant.supplierId,
      reversedAt: new Date().toISOString(),
      reason: 'Devolução do lote',
    }),
  )
  const after = await imports.get(tenant.tenantId, importId)
  expect(after?.reconciliation).toEqual(kept)
  expect(after?.laterChanges.map((change) => change.kind).sort()).toEqual([
    'payable-reversed',
    'receipt-returned',
  ])
})

it('shows a conflicting duplicate and blocks reconciliation until a reviewer dismisses it', async () => {
  const tenant = await seedTenant(BUYER_A)
  const orderLine = randomUUID()
  const receiptId = randomUUID()
  await receive(tenant, randomUUID(), receiptId, [
    { lineId: orderLine, itemId: tenant.grainId, quantity: '2', unitPrice: '1000' },
  ])
  const importId = await importInvoice(tenant, 401, '2', '10.00')
  const forged = signNfe55(supplierInvoice(invoice(tenant, 401, '3', '10.00')), credential)
  const conflict = await imports.import({
    tenantId: tenant.tenantId,
    xml: forged,
    actorId: 'user:r',
  })
  expect(conflict).toMatchObject({ outcome: 'conflict', importId })
  expect(
    await imports.import({ tenantId: tenant.tenantId, xml: forged, actorId: 'user:r' }),
  ).toEqual(conflict)
  const blocked = await imports.get(tenant.tenantId, importId)
  expect(blocked).toMatchObject({
    status: 'blocked',
    conflicts: [{ id: conflict.conflictId, dismissed: false, dismissalReason: null }],
  })
  const lines = [{ lineNumber: 1, receiptId, receiptLineId: orderLine, quantity: '2' }]
  await expect(commit(tenant, importId, lines)).rejects.toMatchObject({ code: 'BLOCKED' })
  expect(
    await imports.dismissConflict({
      tenantId: tenant.tenantId,
      importId,
      conflictId: conflict.conflictId as string,
      reason: 'Cópia adulterada recebida por e-mail; a original confere com o recebimento',
      actorId: 'user:r',
    }),
  ).toBe('dismissed')
  expect((await imports.get(tenant.tenantId, importId))?.status).toBe('open')
  expect((await commit(tenant, importId, lines)).decision).toBe('matched')
})

it('never shows one tenant the XML, index or reconciliation of another with the same supplier', async () => {
  const a = await seedTenant(BUYER_A)
  const b = await seedTenant(BUYER_B)
  const importA = await importInvoice(a, 501, '1', '10.00')
  const importB = await importInvoice(b, 501, '1', '10.00')
  expect(await imports.get(b.tenantId, importA)).toBeNull()
  expect(await imports.xml(b.tenantId, importA)).toBeNull()
  expect((await imports.list(b.tenantId, { limit: 100 })).data.map((row) => row.id)).toEqual([
    importB,
  ])
  await expect(
    imports.import({
      tenantId: b.tenantId,
      xml: signedSupplierInvoice(invoice(a, 502, '1', '10.00'), credential),
      actorId: 'user:r',
    }),
  ).rejects.toMatchObject({ code: 'RECIPIENT_MISMATCH' })
  const digests = await admin`select tenant_id, tax_id_digest from fiscal_party_tax_index
    where tenant_id in (${a.tenantId}, ${b.tenantId})`
  expect(new Set(digests.map((row) => row.tax_id_digest)).size).toBe(2)
  await expect(
    reconciliations.reconcile({
      tenantId: b.tenantId,
      importId: importA,
      request: {
        supplierPartyId: b.supplierId,
        lines: [],
        unmatchedLines: [1],
        rememberMappings: false,
      },
      idempotencyKey: `reconcile-${randomUUID()}`,
      actorId: 'user:r',
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' })

  await ingress.accept(envelope(a.tenantId, 'parties.party.erased', { partyId: a.supplierId }))
  expect((await imports.get(a.tenantId, importA))?.supplier.candidatePartyIds).toEqual([])
  expect((await imports.get(b.tenantId, importB))?.supplier.candidatePartyIds).toEqual([
    b.supplierId,
  ])
})

async function seedTenant(buyer: string): Promise<Tenant> {
  const tenantId = randomUUID()
  const supplierId = randomUUID()
  const grainId = randomUUID()
  const sackId = randomUUID()
  await projections.storeIssuer(tenantId, 1, {
    tenantId,
    revision: 1,
    effectiveFrom: '2026-01-01',
    timezone: 'America/Sao_Paulo',
    company: {
      legalName: 'Comprador de Teste LTDA',
      tradeName: null,
      taxId: buyer,
      stateRegistration: '444555666',
      municipalRegistration: null,
      address: {
        line: 'Avenida do Comprador, 10',
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
  await projections.storeParty(tenantId, supplierId, 1, {
    tenantId,
    partyId: supplierId,
    kind: 'organization',
    legalName: 'Fornecedor de Teste LTDA',
    tradeName: null,
    taxId: SUPPLIER,
    revision: 1,
    profile: {
      effectiveFrom: '2026-01-01',
      stateRegistration: '111222333',
      municipalRegistration: null,
      taxpayerIndicator: 'contributor',
      finalConsumer: false,
      address: {
        street: 'Rua do Fornecedor',
        number: '10',
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
  for (const [itemId, ncm] of [
    [grainId, GRAIN_NCM],
    [sackId, '63051000'],
  ] as const)
    await projections.storeClassification(tenantId, itemId, 1, {
      tenantId,
      itemId,
      revision: 1,
      effectiveFrom: '2026-01-01',
      ncm,
    })
  return { tenantId, supplierId, grainId, sackId, buyer }
}

/** An estimate Fiscal issued for a purchase, kept as its API keeps every estimate (Phase 91). */
async function issueEstimate(
  tenant: Tenant,
  lines: Array<{ itemId: string; quantity: string }>,
  supplierPartyId = tenant.supplierId,
): Promise<string> {
  const money = (amount: string) => ({ amount, currency: 'BRL' })
  const resultDigest = randomBytes(32).toString('hex')
  await estimateRecords.keep(
    tenant.tenantId,
    {
      direction: 'purchase',
      establishmentId: tenant.tenantId,
      supplierPartyId,
      supplier: { regime: 'normal' },
      issueDate: '2026-09-20',
      lines: lines.map((line) => ({ ...line, unitPrice: money('1000') })),
    },
    {
      schemaVersion: 1,
      supported: true,
      estimatedAt: '2026-09-20T12:00:00.000Z',
      components: [
        { group: 'legacy', code: 'ICMS', amount: money('720'), outcome: 'levied' },
        { group: 'legacy', code: 'PIS', amount: money('99'), outcome: 'levied' },
      ],
      totals: {
        net: money('6000'),
        tax: money('819'),
        chargedOnTop: money('0'),
        gross: money('6000'),
      },
      inputDigest: 'a'.repeat(64),
      rulesDigest: 'b'.repeat(64),
      resultDigest,
    },
  )
  return resultDigest
}

/** An order of six sacks of grain, carrying `resultDigest`, received and reconciled. */
async function reconciledWithEstimate(tenant: Tenant, invoiceNumber: number, resultDigest: string) {
  const money = (amount: string) => ({ amount, currency: 'BRL' })
  const orderLine = randomUUID()
  const orderId = randomUUID()
  // What the order says Fiscal estimated: a digest, and components Fiscal never reads.
  await approveOrder(
    tenant,
    orderId,
    [{ lineId: orderLine, itemId: tenant.grainId, quantity: '6' }],
    {
      components: [{ code: 'ICMS', amount: money('1') }],
      chargedOnTop: money('0'),
      inputDigest: 'a'.repeat(64),
      rulesDigest: 'b'.repeat(64),
      resultDigest,
    },
  )
  const receiptId = randomUUID()
  await receive(tenant, orderId, receiptId, [
    { lineId: orderLine, itemId: tenant.grainId, quantity: '6', unitPrice: '1000' },
  ])
  const importId = await importInvoice(tenant, invoiceNumber, '6', '10.00')
  const reconciliation = await commit(tenant, importId, [
    { lineNumber: 1, receiptId, receiptLineId: orderLine, quantity: '6' },
  ])
  return { orderId, reconciliation }
}

it('compares the taxes the supplier charged with the estimate Fiscal issued for the order (Phases 87 and 91)', async () => {
  const tenant = await seedTenant(BUYER_A)
  const resultDigest = await issueEstimate(tenant, [{ itemId: tenant.grainId, quantity: '6' }])
  // The test supplier's XML states no legacy tax: the difference is the whole estimate.
  const { orderId, reconciliation } = await reconciledWithEstimate(tenant, 301, resultDigest)
  // The estimate never binds the supplier: the value reconciles, the taxes are shown apart.
  expect(reconciliation.decision).toBe('matched')
  expect(reconciliation.comparison.clean).toBe(true)
  expect(reconciliation.comparison.taxes).toEqual({
    compared: true,
    orderId,
    estimateDigest: resultDigest,
    components: [
      { code: 'ICMS', invoicedMinor: '0', expectedMinor: '720', differenceMinor: '-720' },
      { code: 'PIS', invoicedMinor: '0', expectedMinor: '99', differenceMinor: '-99' },
    ],
    clean: false,
  })
})

it('compares nothing with an estimate Fiscal never issued, or issued for another purchase (Phase 91)', async () => {
  const tenant = await seedTenant(BUYER_A)
  const notCompared = {
    compared: false,
    reason: 'The purchase order carries no tax estimate',
    components: [],
    clean: true,
  }
  const forged = await reconciledWithEstimate(tenant, 302, randomBytes(32).toString('hex'))
  expect(forged.reconciliation.comparison.taxes).toEqual(notCompared)
  const otherSupplier = await issueEstimate(
    tenant,
    [{ itemId: tenant.grainId, quantity: '6' }],
    randomUUID(),
  )
  const elsewhere = await reconciledWithEstimate(tenant, 303, otherSupplier)
  expect(elsewhere.reconciliation.comparison.taxes).toEqual(notCompared)
  const otherLines = await issueEstimate(tenant, [{ itemId: tenant.grainId, quantity: '7' }])
  const changed = await reconciledWithEstimate(tenant, 304, otherLines)
  expect(changed.reconciliation.comparison.taxes).toEqual(notCompared)
})

function invoice(tenant: Tenant, number: number, quantity: string, unitPrice: string) {
  return {
    supplierTaxId: SUPPLIER,
    recipientTaxId: tenant.buyer,
    number,
    lines: [
      { productCode: 'GR-01', description: 'Grão verde', ncm: GRAIN_NCM, quantity, unitPrice },
    ],
  }
}

async function importInvoice(
  tenant: Tenant,
  number: number,
  quantity: string,
  unitPrice: string,
): Promise<string> {
  const result = await imports.import({
    tenantId: tenant.tenantId,
    xml: signedSupplierInvoice(invoice(tenant, number, quantity, unitPrice), credential),
    actorId: 'user:r',
  })
  expect(result.outcome).toBe('created')
  return result.importId
}

async function commit(
  tenant: Tenant,
  importId: string,
  lines: InboundReconciliationRequest['lines'],
  overrideReason?: string,
) {
  const { reconciliation } = await reconciliations.reconcile({
    tenantId: tenant.tenantId,
    importId,
    request: {
      supplierPartyId: tenant.supplierId,
      lines,
      unmatchedLines: [],
      rememberMappings: false,
      ...(overrideReason ? { overrideReason } : {}),
    },
    idempotencyKey: `reconcile-${randomUUID()}`,
    actorId: 'user:reviewer',
  })
  return reconciliation
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

async function approveOrder(
  tenant: Tenant,
  orderId: string,
  lines: Array<{ lineId: string; itemId: string; quantity: string }>,
  taxEstimate?: Record<string, unknown>,
) {
  const money = (amount: string) => ({ amount, currency: 'BRL' })
  const event = envelope(tenant.tenantId, 'procurement.order.approved', {
    ...(taxEstimate ? { taxEstimate } : {}),
    orderId,
    orderVersion: 1,
    approvedBy: 'user:buyer',
    approvalRequired: false,
    installments: [{ number: 1, dueOn: '2026-10-30', amount: money('10000') }],
    supplierId: tenant.supplierId,
    supplierName: 'Fornecedor de Teste LTDA',
    requisitionId: null,
    warehouseId: randomUUID(),
    issuedOn: '2026-09-20',
    expectedOn: '2026-09-25',
    total: money('10000'),
    lines: lines.map((line) => ({
      ...line,
      description: 'Grão verde',
      unitPrice: money('1000'),
      lineTotal: money('10000'),
    })),
  })
  await ingress.accept(event)
  return event
}

async function receive(
  tenant: Tenant,
  orderId: string,
  receiptId: string,
  lines: Array<{ lineId: string; itemId: string; quantity: string; unitPrice: string }>,
) {
  const money = (amount: string) => ({ amount, currency: 'BRL' })
  const total = lines.reduce(
    (sum, line) => sum + BigInt(line.unitPrice) * BigInt(line.quantity),
    0n,
  )
  const event = envelope(tenant.tenantId, 'procurement.receipt.recorded', {
    orderId,
    orderVersion: 1,
    receiptId,
    receivedBy: 'user:warehouse',
    receivedOn: '2026-09-24',
    supplierId: tenant.supplierId,
    supplierName: 'Fornecedor de Teste LTDA',
    warehouseId: randomUUID(),
    notes: null,
    overReceipt: false,
    complete: false,
    value: money(total.toString()),
    installments: [],
    remaining: money('0'),
    remainingInstallments: [],
    lines: lines.map((line) => ({
      lineId: line.lineId,
      itemId: line.itemId,
      quantity: line.quantity,
      description: 'Grão verde',
      unitPrice: money(line.unitPrice),
      lineTotal: money((BigInt(line.unitPrice) * BigInt(line.quantity)).toString()),
    })),
  })
  expect(await ingress.accept(event)).toBe('applied')
  return event
}

async function postPayable(tenant: Tenant, titleId: string, receiptId: string, amount: string) {
  const event = envelope(tenant.tenantId, 'financial.payable.posted', {
    titleId,
    partyId: tenant.supplierId,
    documentNumber: `GR-${receiptId.slice(-8)}`,
    origin: { type: 'purchase-receipt', documentId: receiptId },
    categoryId: randomUUID(),
    issuedOn: '2026-09-24',
    competenceOn: '2026-09-24',
    total: { amount, currency: 'BRL' },
    installments: [{ number: 1, dueOn: '2026-10-24', amount: { amount, currency: 'BRL' } }],
    allocations: [],
    postedAt: new Date().toISOString(),
  })
  expect(await ingress.accept(event)).toBe('applied')
  return event
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
