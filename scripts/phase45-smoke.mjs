#!/usr/bin/env node
/**
 * Phase 45 local-stack smoke through Kong. A real Sales shipment is issued, returned and
 * its return NF-e authorized; a real Procurement receipt is reconciled with a supplier
 * NF-e, returned and its purchase-return NF-e authorized; the sale gets a value
 * complement and a correction letter, and its cancellation is refused while they stand.
 * Stock and money are counted before and after: Fiscal adds no effect of its own.
 *
 *   node scripts/phase45-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
 *     [--postgres-container horizon-postgres]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const tenantId = flag('tenant', '01a0c5f8-798b-721e-912e-9b505406e614')
const baseUrl = flag('base-url', 'http://localhost:8000').replace(/\/$/, '')
const postgresContainer = flag('postgres-container', 'horizon-postgres')
const today = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10)

const mint = (...roles) =>
  execFileSync(
    process.execPath,
    [
      join(root, 'infra/scripts/mint-dev-token.mjs'),
      '--tenant',
      tenantId,
      '--sub',
      randomUUID(),
      ...roles.flatMap((role) => ['--role', role]),
    ],
    { encoding: 'utf8' },
  ).trim()
const operator = mint(
  'identity:admin',
  'parties:admin',
  'sales:admin',
  'procurement:admin',
  'financial:admin',
  'inventory:admin',
  'catalog:admin',
  'fiscal:admin',
)
const approver = mint('procurement:admin', 'financial:admin')

async function call(path, { method = 'GET', body, token = operator, key = method === 'GET' ? undefined : randomUUID(), type } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': type ?? 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: type ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

async function ok(path, options) {
  const result = await call(path, options)
  if (result.status >= 400)
    throw new Error(`${options?.method ?? 'GET'} ${path}: HTTP ${result.status} ${JSON.stringify(result.body)}`)
  return result.body
}

async function until(label, probe, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`)
}

/** The only lookup without an API yet: the Sales intent behind a shipment (Phase 48 screen). */
function intentOf(shipmentId, purpose) {
  const sql = `select id from fiscal_intents where tenant_id = '${tenantId}' and origin_id = '${shipmentId}' and purpose = '${purpose}'`
  return execFileSync(
    'docker',
    ['exec', postgresContainer, 'psql', '-U', 'postgres', '-d', 'horizon_fiscal', '-At', '-c', sql],
    { encoding: 'utf8' },
  ).trim()
}

function cnpj() {
  const base = Array.from({ length: 12 }, (_, index) => (index < 8 ? Math.floor(Math.random() * 10) : [0, 0, 0, 1][index - 8]))
  const digit = (digits) => {
    const weights = digits.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const rest = digits.reduce((sum, value, index) => sum + value * weights[index], 0) % 11
    return rest < 2 ? 0 : 11 - rest
  }
  const first = digit(base)
  return [...base, first, digit([...base, first])].join('')
}

const fiscalProfile = {
  effectiveFrom: '2026-01-01',
  stateRegistration: '111222333',
  municipalRegistration: null,
  taxpayerIndicator: 'contributor',
  finalConsumer: false,
  address: {
    street: 'Rua da Parte',
    number: '10',
    complement: null,
    district: 'Centro',
    city: 'São Paulo',
    municipalityCode: '3550308',
    state: 'SP',
    postalCode: '01001000',
    country: 'BR',
  },
}

async function party(role, legalName) {
  const taxId = cnpj()
  const created = await ok('/parties/parties', {
    method: 'POST',
    body: {
      kind: 'organization',
      taxId,
      roles: [role],
      legalName,
      email: `${role}@example.com`,
      phone: '1130000000',
      address: 'Rua da Parte, 10, São Paulo',
    },
  })
  const id = created.id ?? created.partyId
  await ok(`/parties/parties/${id}/fiscal-profile`, { method: 'PUT', body: fiscalProfile })
  return { id, taxId }
}

async function issue(documentId) {
  await until('the document to become ready', async () => {
    const ready = await call(`/fiscal/documents/${documentId}/validate`, { method: 'POST' })
    if (ready.status >= 400) throw new Error(JSON.stringify(ready.body))
    return ready.body.document.status === 'ready'
  })
  const queued = await call(`/fiscal/documents/${documentId}/issue`, { method: 'POST' })
  assert.equal(queued.status, 202, JSON.stringify(queued.body))
  return until('authorization', async () => {
    const found = await ok(`/fiscal/documents/${documentId}`)
    return found.status === 'authorized' ? found : undefined
  })
}

async function signedXml(document) {
  const response = await fetch(
    `${baseUrl}/fiscal/documents/${document.id}/artifacts/signed_xml?digest=${document.signedXmlDigest}`,
    { headers: { authorization: `Bearer ${operator}` } },
  )
  assert.equal(response.status, 200)
  return response.text()
}

async function linked(request) {
  const key = randomUUID()
  const origin = await until(`the ${request.kind} origin`, async () => {
    const created = await call('/fiscal/linked-origins', { method: 'POST', body: request, key })
    if (created.status === 422 && created.body.code === 'SOURCE_NOT_PROJECTED') return undefined
    if (created.status >= 400) throw new Error(JSON.stringify(created.body))
    return created.body
  })
  const again = await ok('/fiscal/linked-origins', { method: 'POST', body: request, key })
  assert.equal(again.id, origin.id)
  const draft = await ok('/fiscal/documents', {
    method: 'POST',
    body: {
      origin: { kind: 'linked', linkedOriginId: origin.id },
      model: '55',
      environment: 'simulation',
      establishmentId: tenantId,
      series: 1,
    },
  })
  return { origin, document: await issue(draft.id) }
}

const evidence = { checkedAt: new Date().toISOString(), tenantId }
const kinds = await ok('/fiscal/document-kinds')
assert.equal(kinds.kinds.find((entry) => entry.kind === 'remittance').supported, false)
const refused = await call('/fiscal/linked-origins', {
  method: 'POST',
  body: { kind: 'remittance', shipmentId: randomUUID() },
})
assert.equal(refused.status, 400)

const profile = JSON.parse(
  execFileSync('docker', ['exec', 'horizon-fiscal', 'printenv', 'FISCAL_SIMULATION_PROFILE_JSON'], {
    encoding: 'utf8',
  }),
)
const itemId = Object.keys(profile.lineFacts)[0]
assert.ok(profile.linked?.['sale-return'], 'The issuance profile lacks the Phase 45 linked map')
evidence.linkedProfile = Object.keys(profile.linked)
const [warehouse] = await ok('/inventory/warehouses')
const onHand = async () =>
  Number(
    (await ok('/inventory/warehouses'))
      .find((entry) => entry.id === warehouse.id)
      ?.balances.find((balance) => balance.itemId === itemId)?.onHand ?? '0',
  )
const buyerTaxId = (await ok('/identity/workspace')).company.taxId

// --- purchase: receive 6, reconcile the supplier NF-e, return the receipt ---------------
const stockStart = await onHand()
const supplier = await party('supplier', 'Fornecedor Smoke Fase 45 LTDA')
await until('Procurement to know the supplier', async () =>
  (await ok('/procurement/suppliers')).some((entry) => (entry.id ?? entry.partyId) === supplier.id),
)
const orderLine = randomUUID()
const order = await ok('/procurement/orders', {
  method: 'POST',
  body: {
    supplierId: supplier.id,
    warehouseId: warehouse.id,
    currency: 'BRL',
    lines: [{ lineId: orderLine, itemId, quantity: '10', unitPrice: '1000' }],
    issuedOn: today,
    expectedOn: today,
  },
})
const orderId = order.id ?? order.orderId
await ok(`/procurement/orders/${orderId}/place`, { method: 'POST', body: {} })
if ((await ok(`/procurement/orders/${orderId}`)).status === 'pending')
  await ok(`/procurement/orders/${orderId}/approve`, { method: 'POST', body: {}, token: approver })
const receipt = await ok('/procurement/receipts', {
  method: 'POST',
  body: { orderId, receivedOn: today, lines: [{ lineId: orderLine, quantity: '6' }] },
})
const receiptId = receipt.receiptId ?? receipt.id
evidence.receiptId = receiptId
const payable = await until('the receipt payable', async () =>
  (await ok(`/financial/payables?partyId=${supplier.id}&limit=100`)).data?.find(
    (title) => title.origin?.documentId === receiptId,
  ),
)
const categories = (await ok('/financial/categories')).data
const category =
  categories.find((entry) => entry.nature === 'expense' && entry.active !== false) ??
  (await ok('/financial/categories', {
    method: 'POST',
    body: { code: `P45-${Date.now().toString(36)}`.slice(0, 20), name: 'Compras de mercadoria', nature: 'expense' },
  }))
const detail = await ok(`/financial/payables/${payable.id}`)
await ok(`/financial/payables/${payable.id}`, {
  method: 'PUT',
  body: {
    partyId: supplier.id,
    documentNumber: detail.documentNumber ?? detail.reference,
    currency: 'BRL',
    categoryId: category.id,
    issuedOn: detail.issuedOn,
    installments: detail.installments.map((installment) => ({
      dueOn: installment.dueOn,
      amount: installment.amount?.amount ?? installment.amount,
    })),
  },
})
await call(`/financial/payables/${payable.id}/approval-request`, { method: 'POST', body: {} })
await call(`/financial/payables/${payable.id}/approve`, { method: 'POST', body: {}, token: approver })
await ok(`/financial/payables/${payable.id}/post`, { method: 'POST', body: {} })

const directory = await mkdtemp(join(tmpdir(), 'horizon-phase45-smoke-'))
const xmlPath = join(directory, 'supplier.xml')
const item = await ok(`/catalog/items/${itemId}`)
execFileSync(
  process.execPath,
  [
    join(root, 'fiscal/dist/phase44-supplier-invoice-cli.js'),
    '--supplier-tax-id',
    supplier.taxId,
    '--recipient-tax-id',
    buyerTaxId,
    '--number',
    String(Math.floor(Math.random() * 900_000) + 1),
    '--line',
    `SMK-45|${item.ncm ?? '09012100'}|6|10.00|${item.name}`,
    '--out',
    xmlPath,
    '--protocol',
  ],
  { encoding: 'utf8', env: { ...process.env, FISCAL_ALLOW_SUPPLIER_FIXTURE: 'true' } },
)
const xml = await readFile(xmlPath)
await rm(directory, { recursive: true, force: true })
const imported = await call('/fiscal/imports', { method: 'POST', body: xml, type: 'application/xml' })
assert.equal(imported.status, 201, JSON.stringify(imported.body))
const importId = imported.body.importId
const view = await until('Fiscal to propose the receipt', async () => {
  const found = await ok(`/fiscal/imports/${importId}`)
  return found.proposals[0]?.allocations.length > 0 &&
    found.supplier.candidatePartyIds.includes(supplier.id)
    ? found
    : undefined
})
await ok(`/fiscal/imports/${importId}/reconciliation`, {
  method: 'POST',
  body: {
    supplierPartyId: supplier.id,
    lines: view.proposals[0].allocations.map((allocation) => ({ ...allocation, lineNumber: 1 })),
    unmatchedLines: [],
    rememberMappings: false,
  },
})
const stockAfterReceipt = await onHand()
const early = await call('/fiscal/linked-origins', {
  method: 'POST',
  body: { kind: 'purchase-return', receiptId, establishmentId: tenantId },
})
assert.equal(early.body.code, 'SOURCE_NOT_PROJECTED')
await ok(`/procurement/receipts/${receiptId}/return`, {
  method: 'POST',
  body: { reason: 'Lote devolvido no smoke da fase 45' },
})
const purchaseReturn = await linked({
  kind: 'purchase-return',
  receiptId,
  establishmentId: tenantId,
})
const purchaseXml = await signedXml(purchaseReturn.document)
assert.match(purchaseXml, /<tpNF>1<\/tpNF>/)
assert.match(purchaseXml, /<finNFe>4<\/finNFe>/)
assert.match(purchaseXml, /<CFOP>5202<\/CFOP>/)
assert.ok(purchaseXml.includes(`<CNPJ>${supplier.taxId}</CNPJ>`))
// Financial withdraws only a draft payable on a return; a posted one is reversed by a
// person. Fiscal reverses nothing: it only shows the reversal once Financial publishes it.
const beforeReversal = await ok(`/fiscal/documents/${purchaseReturn.document.id}/links`)
assert.deepEqual(
  beforeReversal.correlations.find((entry) => entry.module === 'financial').observedIds,
  [],
)
assert.equal((await ok(`/financial/payables/${payable.id}`)).status, 'posted')
await ok(`/financial/payables/${payable.id}/reverse`, {
  method: 'POST',
  body: { reason: 'Mercadoria devolvida ao fornecedor no smoke da fase 45' },
})
const purchaseLinks = await until('the payable reversal to be correlated', async () => {
  const found = await ok(`/fiscal/documents/${purchaseReturn.document.id}/links`)
  return found.correlations.find((entry) => entry.module === 'financial')?.observedIds.length
    ? found
    : undefined
})
assert.deepEqual(
  purchaseLinks.correlations.find((entry) => entry.module === 'financial').observedIds,
  [payable.id],
)
evidence.purchaseReturn = {
  linkedOriginId: purchaseReturn.origin.id,
  documentId: purchaseReturn.document.id,
  status: purchaseReturn.document.status,
  references: purchaseLinks.references,
  correlations: purchaseLinks.correlations,
}

// --- sale: ship 2, issue the sale NF-e, return the shipment ------------------------------
const customer = await party('customer', 'Cliente Smoke Fase 45 LTDA')
await until('Sales to know the customer', async () =>
  (await ok('/sales/customers')).some((entry) => (entry.id ?? entry.partyId) === customer.id),
)
const saleLine = randomUUID()
const placed = await ok('/sales/orders', {
  method: 'POST',
  body: {
    customerId: customer.id,
    fulfillmentWarehouseId: warehouse.id,
    currency: 'BRL',
    lines: [{ lineId: saleLine, itemId, quantity: '2' }],
  },
})
const salesOrderId = placed.orderId ?? placed.id
await until('the sales order to be confirmed', async () =>
  (await ok(`/sales/orders/${salesOrderId}`)).status === 'confirmed',
)
const stockBeforeSale = await onHand()
const picked = await ok('/sales/shipments', {
  method: 'POST',
  body: { orderId: salesOrderId, lines: [{ lineId: saleLine, quantity: '2' }] },
})
const shipmentId = picked.shipmentId ?? picked.id
await ok(`/sales/shipments/${shipmentId}/pack`, { method: 'POST', body: {} })
await ok(`/sales/shipments/${shipmentId}/dispatch`, { method: 'POST', body: {} })
const saleIntent = await until('the Sales fiscal origin', async () => intentOf(shipmentId, 'original'))
const saleDraft = await ok('/fiscal/documents', {
  method: 'POST',
  body: {
    origin: { kind: 'sales', intentId: saleIntent },
    model: '55',
    environment: 'simulation',
    establishmentId: tenantId,
    series: 1,
  },
})
const sale = await issue(saleDraft.id)
const saleXmlBefore = await signedXml(sale)
await ok(`/sales/shipments/${shipmentId}/return`, {
  method: 'POST',
  body: { reason: 'Cliente devolveu no smoke da fase 45' },
})
const saleReturn = await linked({ kind: 'sale-return', shipmentId })
const returnXml = await signedXml(saleReturn.document)
assert.match(returnXml, /<tpNF>0<\/tpNF>/)
assert.match(returnXml, /<finNFe>4<\/finNFe>/)
assert.ok(returnXml.includes(`<refNFe>${sale.accessKey}</refNFe>`))

// --- complement and correction letter on the sale ----------------------------------------
const complement = await linked({
  kind: 'value-complement',
  referencedDocumentId: sale.id,
  reason: 'Reajuste de preço acordado no smoke da fase 45',
  lines: [{ lineId: saleLine, amount: { amount: '150', currency: 'BRL' } }],
})
const complementXml = await signedXml(complement.document)
assert.match(complementXml, /<finNFe>2<\/finNFe>/)
assert.match(complementXml, /<qCom>0\.0000<\/qCom><vUnCom>0<\/vUnCom><vProd>1\.50<\/vProd>/)
const letter = await call(`/fiscal/documents/${sale.id}/correction-letters`, {
  method: 'POST',
  body: { text: 'Corrige o complemento do endereço de entrega: Bloco B.', attestation: true },
})
assert.equal(letter.status, 202, JSON.stringify(letter.body))
const letters = await until('the correction letter to be registered', async () => {
  const found = await ok(`/fiscal/documents/${sale.id}/correction-letters`)
  return found.letters[0]?.status === 'registered' ? found : undefined
})
const blocked = await call(`/fiscal/documents/${sale.id}/cancellation-requests`, {
  method: 'POST',
  body: { reason: 'Tentativa de cancelar a venda com documentos vinculados' },
})
assert.equal(blocked.status, 409)
assert.equal(blocked.body.code, 'CANCELLATION_NOT_ALLOWED')
const saleAfter = await ok(`/fiscal/documents/${sale.id}`)
assert.equal(saleAfter.status, 'authorized')
assert.equal(await signedXml(saleAfter), saleXmlBefore)
const saleLinks = await ok(`/fiscal/documents/${sale.id}/links`)
assert.deepEqual(
  saleLinks.linked.map((entry) => entry.kind).sort(),
  ['sale-return', 'value-complement'],
)

// --- effects stay with their owners ------------------------------------------------------
await new Promise((resolve) => setTimeout(resolve, 4000))
const stockEnd = await onHand()
const receivables = (await ok(`/financial/receivables?partyId=${customer.id}&limit=100`)).data ?? []
const payables = (await ok(`/financial/payables?partyId=${supplier.id}&limit=100`)).data ?? []
evidence.sale = {
  documentId: sale.id,
  saleReturnDocumentId: saleReturn.document.id,
  complementDocumentId: complement.document.id,
  correctionLetter: letters.letters[0] && {
    sequence: letters.letters[0].sequence,
    status: letters.letters[0].status,
  },
  linked: saleLinks.linked.map((entry) => ({ kind: entry.kind, status: entry.status, void: entry.void })),
  correlations: saleLinks.correlations,
  cancellation: blocked.body.code,
}
evidence.effects = {
  stockDeltaReceipt: stockAfterReceipt - stockStart,
  stockDeltaSale: stockEnd - stockBeforeSale,
  stockDeltaTotal: stockEnd - stockStart,
  receivables: receivables.map((title) => ({ status: title.status, stage: title.stage })),
  payables: payables.map((title) => ({ status: title.status, stage: title.stage })),
}
assert.equal(evidence.effects.stockDeltaReceipt, 6)
assert.equal(evidence.effects.stockDeltaTotal, 0)
console.log(JSON.stringify(evidence, null, 2))
