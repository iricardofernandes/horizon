import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fiscalDocumentLinksSchema, fiscalLinkedDocumentOutcome } from '@horizon/contracts'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EncryptedFiscalArtifactStore, LocalObjectStore } from '../src/artifact-store'
import { FiscalArtifacts } from '../src/artifacts'
import { type AuditRow, verifyAuditRows } from '../src/audit'
import { FiscalCalculations } from '../src/calculations'
import { FiscalCancellation } from '../src/cancellation'
import { FiscalCapabilities } from '../src/capabilities'
import { CorrectionLetterError, FiscalCorrectionLetters } from '../src/correction-letters'
import { FiscalDispatch } from '../src/dispatch'
import { PHASE45_FIXTURES, supportedKind, UnsupportedDocumentKind } from '../src/document-kinds'
import { FiscalDocumentLinksReader } from '../src/document-links'
import { FiscalDocuments } from '../src/documents'
import { FiscalInboundImports } from '../src/inbound-imports'
import { FiscalInboundReconciliations } from '../src/inbound-reconciliations'
import { FiscalIngress } from '../src/ingress'
import { FiscalIssuance, type Nfe55SimulationProfile } from '../src/issuance'
import { FiscalIssueWorker } from '../src/issue-worker'
import { FiscalLinkedOrigins, LinkedOriginError } from '../src/linked-origins'
import type { SimulationCredential } from '../src/nfe55/signature'
import { DeterministicNfe55Simulator, type SimulatorScenario } from '../src/nfe55/simulator'
import { approvedPhase41Source, PHASE41_FIXTURE_ID } from '../src/phase41-approved-scenario'
import { approvedPhase45Source } from '../src/phase45-approved-scenario'
import { FiscalProjections } from '../src/projections'
import { FiscalReadiness } from '../src/readiness'
import { FiscalRuleStore } from '../src/rule-store'
import { signedSupplierInvoice, supplierCredential } from './support/inbound-nfe'

const run = promisify(execFile)
const DOCUMENT_SCHEMA = 'b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998'
const EVENT_SCHEMA = '45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b'
const ISSUER = '98765432000100'
const CUSTOMER = '11222333000181'
const SUPPLIER = '12345678000195'
const COFFEE_NCM = '09012100'

let container: StartedPostgreSqlContainer
let admin: ReturnType<typeof postgres>
let url: string
let directory: string
let masterKey: Buffer
let supplierSigner: SimulationCredential
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
let imports: FiscalInboundImports
let reconciliations: FiscalInboundReconciliations
let linkedOrigins: FiscalLinkedOrigins
let links: FiscalDocumentLinksReader
let documentZip: Buffer
let eventZip: Buffer
const services: Array<{ close(): Promise<void> }> = []

type Tenant = {
  tenantId: string
  establishmentId: string
  customerId: string
  supplierId: string
  coffeeId: string
  capabilities: Record<'sale' | 'sale-return' | 'purchase-return' | 'value-complement', string>
  issuance: FiscalIssuance
  cancellation: FiscalCancellation
  letters: FiscalCorrectionLetters
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('horizon_phase45_linked_test')
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
  directory = await mkdtemp(join(tmpdir(), 'horizon-phase45-'))
  masterKey = randomBytes(32)
  await Promise.all([mkdir(join(directory, 'supplier')), mkdir(join(directory, 'issuer'))])
  supplierSigner = await supplierCredential(join(directory, 'supplier'), SUPPLIER)
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
  const objects = new EncryptedFiscalArtifactStore(
    new LocalObjectStore(join(directory, 'objects')),
    masterKey,
  )
  artifacts = new FiscalArtifacts(url, objects)
  readiness = new FiscalReadiness(documents, projections, capabilities, calculations)
  imports = new FiscalInboundImports(url, masterKey, objects, projections, {
    zip: documentZip,
    digest: DOCUMENT_SCHEMA,
  })
  reconciliations = new FiscalInboundReconciliations(url, masterKey, projections)
  linkedOrigins = new FiscalLinkedOrigins(url, masterKey, documents, () => ({
    async catalogItem(id) {
      return { id, kind: 'product', name: 'Café torrado em grãos', active: true }
    },
  }))
  links = new FiscalDocumentLinksReader(url)
  services.push(
    ingress,
    projections,
    store,
    calculations,
    capabilities,
    documents,
    dispatch,
    artifacts,
    imports,
    reconciliations,
    linkedOrigins,
    links,
  )
}, 180_000)

afterAll(async () => {
  await Promise.allSettled([...services.map((service) => service.close()), admin?.end()])
  await container?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('Phase 45 linked documents', () => {
  it('returns a Sales shipment against its authorized sale and keeps both readable', async () => {
    const tenant = await seedTenant()
    const shipmentId = randomUUID()
    const lineId = randomUUID()
    const sale = await issueSale(tenant, shipmentId, lineId, '3')
    const saleXml = await signedXml(tenant, sale.id)

    await expect(
      linkedOrigins.create({
        tenantId: tenant.tenantId,
        idempotencyKey: key(),
        actorId: 'user:issuer',
        request: { kind: 'sale-return', shipmentId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_PROJECTED' })

    await recordSalesOrigin(tenant, shipmentId, lineId, '3', 'return')
    const request = { kind: 'sale-return' as const, shipmentId }
    const firstKey = key()
    const origin = await linkedOrigins.create({
      tenantId: tenant.tenantId,
      idempotencyKey: firstKey,
      actorId: 'user:issuer',
      request,
    })
    expect(origin).toMatchObject({ kind: 'sale-return', existing: false })
    expect(
      await linkedOrigins.create({
        tenantId: tenant.tenantId,
        idempotencyKey: firstKey,
        actorId: 'user:issuer',
        request,
      }),
    ).toMatchObject({ id: origin.id, existing: true })
    expect(
      await linkedOrigins.create({
        tenantId: tenant.tenantId,
        idempotencyKey: key(),
        actorId: 'user:other',
        request,
      }),
    ).toMatchObject({ id: origin.id, existing: true })

    const returned = await issueLinked(tenant, origin.id)
    expect(returned.status).toBe('authorized')
    const xml = await signedXml(tenant, returned.id)
    expect(xml).toContain('<tpNF>0</tpNF>')
    expect(xml).toContain('<finNFe>4</finNFe>')
    expect(xml).toContain(`<NFref><refNFe>${sale.accessKey}</refNFe></NFref>`)
    expect(xml).toContain('<CFOP>1202</CFOP>')

    const original = await documents.get(tenant.tenantId, sale.id)
    expect(original?.status).toBe('authorized')
    expect(await signedXml(tenant, sale.id)).toBe(saleXml)
    const view = fiscalDocumentLinksSchema.parse(await links.read(tenant.tenantId, sale.id))
    expect(view).toMatchObject({
      kind: 'sale',
      linked: [
        {
          linkedOriginId: origin.id,
          kind: 'sale-return',
          documentId: returned.id,
          status: 'authorized',
          void: false,
          lines: [
            {
              lineId,
              referenceKey: `document:${sale.id}:${lineId}`,
              referenceQuantity: '3',
              quantity: '3',
            },
          ],
        },
      ],
      correlations: [
        { module: 'inventory', sourceEvent: 'sales.shipment.returned', correlationId: shipmentId },
        { module: 'financial', sourceEvent: 'sales.shipment.returned', correlationId: shipmentId },
      ],
    })
    expect(
      fiscalDocumentLinksSchema.parse(await links.read(tenant.tenantId, returned.id)),
    ).toMatchObject({
      kind: 'sale-return',
      references: [{ type: 'document', documentId: sale.id }],
    })

    const outcome = (await outbox(tenant)).find(
      (row) => row.event_type === fiscalLinkedDocumentOutcome.type,
    )
    const event = fiscalLinkedDocumentOutcome.payload.parse(outcome?.payload)
    expect(event).toMatchObject({
      kind: 'sale-return',
      outcome: 'authorized',
      source: { module: 'sales', documentType: 'shipment', id: shipmentId },
      references: [{ type: 'document', documentId: sale.id }],
    })
    expect(JSON.stringify(event)).not.toContain(String(sale.accessKey))

    await expect(cancel(tenant, sale.id)).rejects.toThrow('blocked by linked documents')
    await expect(
      admin`insert into fiscal_dispatch_commands
        (id, tenant_id, document_id, kind, idempotency_key, request_digest, actor_id)
        values (${randomUUID()}, ${tenant.tenantId}, ${sale.id}, 'cancellation', ${key()},
          ${'a'.repeat(64)}, 'test:direct')`,
    ).rejects.toThrow('blocked by linked documents')

    await cancel(tenant, returned.id)
    await work(tenant, 'authorized')
    expect((await documents.get(tenant.tenantId, returned.id))?.status).toBe('cancelled')
    expect((await links.read(tenant.tenantId, sale.id))?.linked[0]).toMatchObject({ void: true })

    await cancel(tenant, sale.id)
    await work(tenant, 'rejected')
    expect((await documents.get(tenant.tenantId, sale.id))?.status).toBe('authorized')
    const kept = (await artifacts.list(tenant.tenantId, sale.id))?.artifacts.map((row) => row.kind)
    expect(kept).toEqual(expect.arrayContaining(['signed_xml', 'cancellation_response']))
    const audit = await scoped(
      tenant.tenantId,
      (tx) => tx<AuditRow[]>`select * from fiscal_audit_entries order by sequence`,
    )
    expect(verifyAuditRows(audit)).toBe(true)
  })

  it('returns part of a purchase against the reconciled supplier NF-e and never over-returns', async () => {
    const tenant = await seedTenant()
    const orderId = randomUUID()
    const orderLine = randomUUID()
    const [first, second, unreconciled] = [randomUUID(), randomUUID(), randomUUID()]
    await receive(tenant, orderId, first, orderLine, '6')
    await receive(tenant, orderId, second, orderLine, '4')
    await receive(tenant, orderId, unreconciled, orderLine, '2')
    const titleId = randomUUID()
    await postPayable(tenant, titleId, first, '6000')
    const imported = await imports.import({
      tenantId: tenant.tenantId,
      xml: signedSupplierInvoice(
        {
          supplierTaxId: SUPPLIER,
          recipientTaxId: ISSUER,
          number: 501,
          lines: [
            {
              productCode: 'CF-01',
              description: 'Café torrado',
              ncm: COFFEE_NCM,
              quantity: '10',
              unitPrice: '10.00',
            },
          ],
        },
        supplierSigner,
      ),
      actorId: 'user:reviewer',
    })
    await reconciliations.reconcile({
      tenantId: tenant.tenantId,
      importId: imported.importId,
      request: {
        supplierPartyId: tenant.supplierId,
        lines: [
          { lineNumber: 1, receiptId: first, receiptLineId: orderLine, quantity: '6' },
          { lineNumber: 1, receiptId: second, receiptLineId: orderLine, quantity: '4' },
        ],
        unmatchedLines: [],
        rememberMappings: false,
      },
      idempotencyKey: key(),
      actorId: 'user:reviewer',
    })

    const purchaseReturn = (receiptId: string) => ({
      kind: 'purchase-return' as const,
      receiptId,
      establishmentId: tenant.establishmentId,
    })
    await expect(
      linkedOrigins.create({
        tenantId: tenant.tenantId,
        idempotencyKey: key(),
        actorId: 'user:buyer',
        request: purchaseReturn(first),
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_PROJECTED' })
    await returnReceipt(tenant, orderId, first, orderLine, '2')
    const partial = await linkedOrigins.create({
      tenantId: tenant.tenantId,
      idempotencyKey: key(),
      actorId: 'user:buyer',
      request: purchaseReturn(first),
    })
    await returnReceipt(tenant, orderId, unreconciled, orderLine, '2')
    await expect(
      linkedOrigins.create({
        tenantId: tenant.tenantId,
        idempotencyKey: key(),
        actorId: 'user:buyer',
        request: purchaseReturn(unreconciled),
      }),
    ).rejects.toMatchObject({ code: 'REFERENCE_INCOMPLETE' })
    await returnReceipt(tenant, orderId, second, orderLine, '4')
    const whole = await linkedOrigins.create({
      tenantId: tenant.tenantId,
      idempotencyKey: key(),
      actorId: 'user:buyer',
      request: purchaseReturn(second),
    })
    const reference = `import:${imported.importId}:1`
    const held = await scoped(
      tenant.tenantId,
      (tx) => tx`select linked_origin_id, quantity::text, reference_quantity::text
        from fiscal_linked_origin_lines where reference_key = ${reference}
        order by quantity`,
    )
    expect(held.map((row) => [row.quantity, row.reference_quantity])).toEqual([
      ['2.000000', '10.000000'],
      ['4.000000', '10.000000'],
    ])
    await expect(
      admin`insert into fiscal_linked_origin_lines (
          tenant_id, linked_origin_id, line_id, item_id, reference_key, reference_quantity,
          quantity, amount_minor, currency
        ) values (
          ${tenant.tenantId}, ${partial.id}, ${randomUUID()}, ${tenant.coffeeId}, ${reference},
          10, 5, 5000, 'BRL'
        )`,
    ).rejects.toThrow('exceeds the original line')

    const document = await issueLinked(tenant, partial.id)
    expect(document.status).toBe('authorized')
    const xml = await signedXml(tenant, document.id)
    const supplierKey = (await imports.get(tenant.tenantId, imported.importId))?.accessKey
    expect(xml).toContain('<tpNF>1</tpNF><idDest>1</idDest>')
    expect(xml).toContain('<finNFe>4</finNFe>')
    expect(xml).toContain(`<refNFe>${supplierKey}</refNFe>`)
    expect(xml).toContain(`<dest><CNPJ>${SUPPLIER}</CNPJ>`)
    expect(xml).toContain('<CFOP>5202</CFOP>')
    expect(xml).toContain('<qCom>2.0000</qCom>')

    await ingress.accept(
      envelope(tenant.tenantId, 'financial.payable.reversed', {
        titleId,
        partyId: tenant.supplierId,
        reversedAt: new Date().toISOString(),
        reason: 'Devolução parcial ao fornecedor',
      }),
    )
    const view = fiscalDocumentLinksSchema.parse(await links.read(tenant.tenantId, document.id))
    expect(view).toMatchObject({
      kind: 'purchase-return',
      references: [{ type: 'supplier-invoice', importId: imported.importId }],
      correlations: [
        { module: 'inventory', sourceEvent: 'procurement.receipt.returned', correlationId: first },
        {
          module: 'financial',
          sourceEvent: 'procurement.receipt.returned',
          correlationId: first,
          observedIds: [titleId],
        },
      ],
    })
    expect(whole.id).not.toBe(partial.id)
  })

  it('records a value complement independently of the original', async () => {
    const tenant = await seedTenant()
    const lineId = randomUUID()
    const sale = await issueSale(tenant, randomUUID(), lineId, '2')
    const before = await documents.get(tenant.tenantId, sale.id)

    const request = {
      kind: 'value-complement' as const,
      referencedDocumentId: sale.id,
      reason: 'Reajuste de preço acordado após a emissão',
      lines: [{ lineId, amount: { amount: '500', currency: 'BRL' } }],
    }
    const complementKey = key()
    const origin = await linkedOrigins.create({
      tenantId: tenant.tenantId,
      idempotencyKey: complementKey,
      actorId: 'user:reviewer',
      request,
    })
    await expect(
      linkedOrigins.create({
        tenantId: tenant.tenantId,
        idempotencyKey: complementKey,
        actorId: 'user:reviewer',
        request: { ...request, reason: 'Outro motivo para o mesmo pedido' },
      }),
    ).rejects.toMatchObject({ code: 'LINKED_ORIGIN_CONFLICT' })
    const complement = await issueLinked(tenant, origin.id)
    expect(complement.status).toBe('authorized')
    const xml = await signedXml(tenant, complement.id)
    expect(xml).toContain('<finNFe>2</finNFe>')
    expect(xml).toContain('<qCom>0.0000</qCom><vUnCom>0</vUnCom><vProd>5.00</vProd>')

    const after = await documents.get(tenant.tenantId, sale.id)
    expect(after?.calculationDigest).toBe(before?.calculationDigest)
    expect(after?.signedXmlDigest).toBe(before?.signedXmlDigest)
    expect((await links.read(tenant.tenantId, sale.id))?.linked).toMatchObject([
      {
        kind: 'value-complement',
        lines: [{ referenceQuantity: null, quantity: '0', amount: { amount: '500' } }],
      },
    ])
    await expect(
      linkedOrigins.create({
        tenantId: tenant.tenantId,
        idempotencyKey: key(),
        actorId: 'user:reviewer',
        request: { ...request, referencedDocumentId: complement.id },
      }),
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_AUTHORIZED' })
  })

  it('registers correction letters without touching the authorized document', async () => {
    const tenant = await seedTenant()
    const sale = await issueSale(tenant, randomUUID(), randomUUID(), '1')
    const text = 'Corrige o complemento do endereço de entrega para Bloco B.'
    const firstKey = key()
    const first = await tenant.letters.request({
      tenantId: tenant.tenantId,
      documentId: sale.id,
      idempotencyKey: firstKey,
      actorId: 'user:issuer',
      text,
      attestation: true,
    })
    expect(first).toMatchObject({ sequence: 1, existing: false })
    await expect(
      tenant.letters.request({
        tenantId: tenant.tenantId,
        documentId: sale.id,
        idempotencyKey: firstKey,
        actorId: 'user:issuer',
        text: `${text} Outro texto.`,
        attestation: true,
      }),
    ).rejects.toThrow(CorrectionLetterError)
    await expect(cancel(tenant, sale.id)).rejects.toThrow('unresolved correction letter')
    await letterWork(tenant, 'authorized')

    const second = await tenant.letters.request({
      tenantId: tenant.tenantId,
      documentId: sale.id,
      idempotencyKey: key(),
      actorId: 'user:issuer',
      text: 'Corrige a transportadora informada nos dados adicionais.',
      attestation: true,
    })
    expect(second.sequence).toBe(2)
    await letterWork(tenant, 'timeout-after-accept')
    expect((await tenant.letters.list(tenant.tenantId, sale.id))?.letters[1]?.status).toBe(
      'unknown',
    )
    await letterWork(tenant, 'timeout-after-accept')
    await tenant.letters.request({
      tenantId: tenant.tenantId,
      documentId: sale.id,
      idempotencyKey: key(),
      actorId: 'user:issuer',
      text: 'Corrige a observação sobre o horário de entrega.',
      attestation: true,
    })
    await letterWork(tenant, 'rejected')

    const listed = await tenant.letters.list(tenant.tenantId, sale.id)
    expect(listed?.letters.map((letter) => [letter.sequence, letter.status])).toEqual([
      [1, 'registered'],
      [2, 'registered'],
      [3, 'rejected'],
    ])
    expect(listed?.letters[0]?.protocolDigest).toMatch(/^[0-9a-f]{64}$/)
    expect((await documents.get(tenant.tenantId, sale.id))?.status).toBe('authorized')
    const request = await scoped(
      tenant.tenantId,
      (tx) => tx`select count(*)::int as count from fiscal_artifacts
        where document_id = ${sale.id} and kind = 'correction_request'`,
    )
    expect(request[0]?.count).toBe(3)
    const eventXml = await artifacts.get(
      tenant.tenantId,
      sale.id,
      'correction_request',
      String(listed?.letters[0]?.eventXmlDigest),
    )
    expect(eventXml.bytes.toString()).toContain('<tpEvento>110110</tpEvento><nSeqEvento>1')
    expect(eventXml.bytes.toString()).toContain('<xCorrecao>Corrige o complemento')
  })

  it('replays the complete event history to the same quantities and links', async () => {
    const tenant = await seedTenant()
    const shipmentId = randomUUID()
    const lineId = randomUUID()
    const history: unknown[] = []
    const sale = await issueSale(tenant, shipmentId, lineId, '5', history)
    await recordSalesOrigin(tenant, shipmentId, lineId, '5', 'return', history)
    const request = { kind: 'sale-return' as const, shipmentId }
    const commandKey = key()
    const origin = await linkedOrigins.create({
      tenantId: tenant.tenantId,
      idempotencyKey: commandKey,
      actorId: 'user:issuer',
      request,
    })
    await issueLinked(tenant, origin.id)
    const before = await links.read(tenant.tenantId, sale.id)
    const counts = async () =>
      (
        await scoped(
          tenant.tenantId,
          (tx) => tx`select
            (select count(*) from fiscal_intents)::int as intents,
            (select count(*) from fiscal_linked_origins)::int as origins,
            (select count(*) from fiscal_linked_origin_lines)::int as lines,
            (select count(*) from fiscal_documents)::int as documents,
            (select count(*) from fiscal_outbox)::int as outbox`,
        )
      )[0]
    const countsBefore = await counts()

    for (const event of history) expect(await ingress.accept(event)).toBe('duplicate')
    for (const event of history)
      expect(await ingress.accept({ ...(event as object), eventId: randomUUID() })).toBe('applied')
    expect(
      await linkedOrigins.create({
        tenantId: tenant.tenantId,
        idempotencyKey: commandKey,
        actorId: 'user:issuer',
        request,
      }),
    ).toMatchObject({ id: origin.id, existing: true })
    expect(
      await linkedOrigins.create({
        tenantId: tenant.tenantId,
        idempotencyKey: key(),
        actorId: 'user:issuer',
        request,
      }),
    ).toMatchObject({ id: origin.id, existing: true })

    expect(await counts()).toEqual(countsBefore)
    expect((await links.read(tenant.tenantId, sale.id))?.digest).toBe(before?.digest)
  })

  it('cannot issue a kind or tuple that has no reviewed capability', async () => {
    for (const kind of ['remittance', 'adjustment', 'credit-note', 'debit-note'])
      expect(() => supportedKind(kind)).toThrow(UnsupportedDocumentKind)
    await expect(
      linkedOrigins.create({
        tenantId: randomUUID(),
        idempotencyKey: key(),
        actorId: 'user:issuer',
        request: { kind: 'remittance', shipmentId: randomUUID() } as never,
      }),
    ).rejects.toThrow()

    const tenant = await seedTenant()
    const lineId = randomUUID()
    const sale = await issueSale(tenant, randomUUID(), lineId, '1')
    const origin = await linkedOrigins.create({
      tenantId: tenant.tenantId,
      idempotencyKey: key(),
      actorId: 'user:reviewer',
      request: {
        kind: 'value-complement',
        referencedDocumentId: sale.id,
        reason: 'Diferença de preço sem capacidade ativa',
        lines: [{ lineId, amount: { amount: '100', currency: 'BRL' } }],
      },
    })
    await capabilities.change({
      tenantId: tenant.tenantId,
      capabilityId: tenant.capabilities['value-complement'],
      action: 'deactivate',
      evidenceDigest: 'd'.repeat(64),
      actorId: 'test:phase45',
      reason: 'Deactivate the complement tuple for the refusal test.',
      occurredAt: new Date().toISOString(),
    })
    const draft = await documents.createLinkedDraft({
      tenantId: tenant.tenantId,
      linkedOriginId: origin.id,
      establishmentId: tenant.establishmentId,
      series: 1,
      idempotencyKey: key(),
      actorId: 'user:issuer',
    })
    await expect(
      readiness.validate({ tenantId: tenant.tenantId, documentId: draft.id, actorId: 'user:i' }),
    ).rejects.toThrow('Fiscal capability is unsupported')
    expect((await documents.get(tenant.tenantId, draft.id))?.status).toBe('draft')
    expect(LinkedOriginError).toBeDefined()
  })
})

async function seedTenant(): Promise<Tenant> {
  const tenantId = randomUUID()
  const establishmentId = randomUUID()
  const customerId = randomUUID()
  const supplierId = randomUUID()
  const coffeeId = randomUUID()
  await admin`insert into tenants (id) values (${tenantId})`
  for (const source of [
    approvedPhase41Source(tenantId, { byteSize: 1, storageUri: 'file:///test-only/rtc.zip' }),
    approvedPhase45Source(tenantId),
  ]) {
    const imported = await store.importSource(source)
    await store.reviewPackage({
      tenantId,
      packageId: imported.packageId,
      approved: true,
      reviewedBy: 'reviewer:phase45-test',
      reviewedAt: '2026-09-26T12:00:00.000Z',
      interpretation: 'Approved only inside the isolated Phase 45 integration test.',
      fixtureIds: [PHASE41_FIXTURE_ID, ...Object.values(PHASE45_FIXTURES)],
    })
    for (const ruleId of imported.ruleIds)
      await store.activateRule({
        tenantId,
        ruleId,
        action: 'activate',
        actorId: 'test:phase45',
        reason: 'Isolated Phase 45 integration fixture',
      })
  }
  const capabilityIds = {} as Tenant['capabilities']
  for (const [kind, operation, fixture] of [
    ['sale', 'normal-sale', PHASE41_FIXTURE_ID],
    ['sale-return', 'sale-return', PHASE45_FIXTURES['sale-return']],
    ['purchase-return', 'purchase-return', PHASE45_FIXTURES['purchase-return']],
    ['value-complement', 'value-complement', PHASE45_FIXTURES['value-complement']],
  ] as const) {
    const definition = await capabilities.register({
      tenantId,
      model: '55',
      environment: 'simulation',
      establishmentId,
      jurisdictionKind: 'uf',
      jurisdictionCode: 'SP',
      operation,
      adapterVersion: 'nfe55-simulator-v1',
      sourceManifestDigest: '6'.repeat(64),
      schemaPackageDigest: DOCUMENT_SCHEMA,
      calculationFixtureId: fixture,
      createdBy: 'test:phase45',
    })
    await capabilities.review({
      tenantId,
      capabilityId: definition.id,
      approved: true,
      reviewedBy: 'reviewer:phase45-test',
      interpretation: 'Test-only authorization of the Phase 45 simulation tuple.',
      reviewedAt: '2026-09-26T12:00:00.000Z',
    })
    await capabilities.change({
      tenantId,
      capabilityId: definition.id,
      action: 'activate_simulated',
      evidenceDigest: '9'.repeat(64),
      actorId: 'test:phase45',
      reason: 'Activate only the isolated Phase 45 test fixture.',
      occurredAt: '2026-09-26T12:01:00.000Z',
    })
    capabilityIds[kind] = definition.id
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
  for (const [partyId, taxId, legalName] of [
    [customerId, CUSTOMER, 'Cliente Simulado LTDA'],
    [supplierId, SUPPLIER, 'Fornecedor de Teste LTDA'],
  ] as const)
    await projections.storeParty(tenantId, partyId, 1, {
      tenantId,
      partyId,
      kind: 'organization',
      legalName,
      tradeName: null,
      taxId,
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
  await projections.storeClassification(tenantId, coffeeId, 1, {
    tenantId,
    itemId: coffeeId,
    revision: 1,
    effectiveFrom: '2026-01-01',
    ncm: COFFEE_NCM,
  })
  const profile: Nfe55SimulationProfile = {
    capabilityId: capabilityIds.sale,
    issuerAddress: { street: 'Rua Um', number: '1', complement: null, district: 'Centro' },
    linked: {
      'sale-return': {
        capabilityId: capabilityIds['sale-return'],
        cfop: '1202',
        natureOperation: 'Devolução de venda de mercadoria',
      },
      'purchase-return': {
        capabilityId: capabilityIds['purchase-return'],
        cfop: '5202',
        natureOperation: 'Devolução de compra para comercialização',
      },
      'value-complement': {
        capabilityId: capabilityIds['value-complement'],
        cfop: '5102',
        natureOperation: 'Complemento de valor',
      },
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
    customerId,
    supplierId,
    coffeeId,
    capabilities: capabilityIds,
    issuance,
    cancellation,
    letters,
  }
}

async function recordSalesOrigin(
  tenant: Tenant,
  shipmentId: string,
  lineId: string,
  quantity: string,
  purpose: 'original' | 'return',
  history?: unknown[],
): Promise<string> {
  const lineTotal = (BigInt(quantity) * 1000n).toString()
  const event = envelope(tenant.tenantId, 'sales.fiscal-origin.recorded', {
    orderId: randomUUID(),
    originModule: 'sales',
    originDocumentType: 'shipment',
    originId: shipmentId,
    purpose,
    customerId: tenant.customerId,
    lines: [
      {
        lineId,
        itemId: tenant.coffeeId,
        quantity,
        description: 'Café torrado em grãos',
        unitPrice: { amount: '1000', currency: 'BRL' },
        lineTotal: { amount: lineTotal, currency: 'BRL' },
      },
    ],
    total: { amount: lineTotal, currency: 'BRL' },
  })
  // Sales records both origins with the same order, as a shipment and its return do.
  if (history && purpose === 'return') {
    const original = history.find(
      (item) => (item as { eventType: string }).eventType === 'sales.fiscal-origin.recorded',
    ) as { payload: { orderId: string } } | undefined
    if (original) (event.payload as { orderId: string }).orderId = original.payload.orderId
  }
  expect(await ingress.accept(event)).toBe('applied')
  history?.push(event)
  const [row] = await scoped(
    tenant.tenantId,
    (tx) => tx`select id from fiscal_intents where origin_id = ${shipmentId}
      and purpose = ${purpose}`,
  )
  return String(row?.id)
}

async function issueSale(
  tenant: Tenant,
  shipmentId: string,
  lineId: string,
  quantity: string,
  history?: unknown[],
) {
  const intentId = await recordSalesOrigin(
    tenant,
    shipmentId,
    lineId,
    quantity,
    'original',
    history,
  )
  const draft = await documents.createDraft({
    tenantId: tenant.tenantId,
    intentId,
    model: '55',
    environment: 'simulation',
    establishmentId: tenant.establishmentId,
    series: 1,
  })
  return authorize(tenant, draft.id)
}

async function issueLinked(tenant: Tenant, linkedOriginId: string) {
  const draft = await documents.createLinkedDraft({
    tenantId: tenant.tenantId,
    linkedOriginId,
    establishmentId: tenant.establishmentId,
    series: 1,
    idempotencyKey: key(),
    actorId: 'user:issuer',
  })
  return authorize(tenant, draft.id)
}

async function authorize(tenant: Tenant, documentId: string) {
  const ready = await readiness.validate({
    tenantId: tenant.tenantId,
    documentId,
    actorId: 'user:issuer',
  })
  expect(ready.supported, JSON.stringify(ready)).toBe(true)
  await tenant.issuance.issue({
    tenantId: tenant.tenantId,
    documentId,
    idempotencyKey: key(),
    actorId: 'user:issuer',
  })
  await work(tenant, 'authorized')
  const document = await documents.get(tenant.tenantId, documentId)
  if (!document) throw new Error('document vanished')
  return document
}

async function work(tenant: Tenant, scenario: SimulatorScenario) {
  await new FiscalIssueWorker(
    dispatch,
    artifacts,
    new DeterministicNfe55Simulator(() => scenario),
    0,
  ).processOne(tenant.tenantId, 'worker:phase45')
}

async function letterWork(tenant: Tenant, scenario: SimulatorScenario) {
  expect(
    await tenant.letters.processOne(
      tenant.tenantId,
      'worker:letters',
      new DeterministicNfe55Simulator(() => scenario),
      0,
    ),
  ).toBe(true)
}

async function cancel(tenant: Tenant, documentId: string) {
  return tenant.cancellation.request({
    tenantId: tenant.tenantId,
    documentId,
    idempotencyKey: key(),
    actorId: 'user:issuer',
    reason: 'Cancelamento solicitado no teste da fase 45',
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

async function receive(
  tenant: Tenant,
  orderId: string,
  receiptId: string,
  lineId: string,
  quantity: string,
) {
  const money = (amount: string) => ({ amount, currency: 'BRL' })
  const total = (BigInt(quantity) * 1000n).toString()
  expect(
    await ingress.accept(
      envelope(tenant.tenantId, 'procurement.receipt.recorded', {
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
        value: money(total),
        installments: [],
        remaining: money('0'),
        remainingInstallments: [],
        lines: [
          {
            lineId,
            itemId: tenant.coffeeId,
            quantity,
            description: 'Café torrado',
            unitPrice: money('1000'),
            lineTotal: money(total),
          },
        ],
      }),
    ),
  ).toBe('applied')
}

async function returnReceipt(
  tenant: Tenant,
  orderId: string,
  receiptId: string,
  lineId: string,
  quantity: string,
) {
  expect(
    await ingress.accept(
      envelope(tenant.tenantId, 'procurement.receipt.returned', {
        orderId,
        orderVersion: 1,
        receiptId,
        returnedBy: 'user:warehouse',
        reason: 'Lote com avaria',
        warehouseId: randomUUID(),
        remaining: { amount: '0', currency: 'BRL' },
        remainingInstallments: [],
        lines: [{ lineId, itemId: tenant.coffeeId, quantity }],
      }),
    ),
  ).toBe('applied')
}

async function postPayable(tenant: Tenant, titleId: string, receiptId: string, amount: string) {
  expect(
    await ingress.accept(
      envelope(tenant.tenantId, 'financial.payable.posted', {
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
      }),
    ),
  ).toBe('applied')
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
  return `phase45-${randomUUID()}`
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
