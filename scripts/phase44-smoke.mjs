#!/usr/bin/env node
/**
 * Phase 44 local-stack smoke through Kong: a real supplier, order, partial receipt and
 * posted payable; a signed supplier NF-e imported twice, reconciled once, and the receipt
 * event replayed on the broker. It proves that importing and reconciling XML never adds a
 * second receipt, stock movement or payable.
 *
 *   node scripts/phase44-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
 *     [--amqp amqp://horizon:horizon@localhost:5672]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { connect } = createRequire(join(root, 'fiscal/package.json'))('amqplib')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const tenantId = flag('tenant', '01a0c5f8-798b-721e-912e-9b505406e614')
const baseUrl = flag('base-url', 'http://localhost:8000').replace(/\/$/, '')
const amqpUrl = flag('amqp', 'amqp://horizon:horizon@localhost:5672')
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
  const json = text ? JSON.parse(text) : null
  return { status: response.status, body: json }
}

async function ok(path, options) {
  const result = await call(path, options)
  if (result.status >= 400)
    throw new Error(`${options?.method ?? 'GET'} ${path}: HTTP ${result.status} ${JSON.stringify(result.body)}`)
  return result.body
}

async function until(label, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined)
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out waiting for ${label}`)
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

const evidence = { checkedAt: new Date().toISOString(), tenantId }
const workspace = await ok('/identity/workspace')
const buyerTaxId = workspace.company.taxId
const [warehouse] = await ok('/inventory/warehouses')
const item = (await ok('/catalog/items?limit=50')).data.find((entry) => entry.active && entry.ncm)
assert.ok(warehouse && item, 'The tenant needs a warehouse and an active classified item')
const onHand = async () =>
  (await ok('/inventory/warehouses'))
    .find((entry) => entry.id === warehouse.id)
    ?.balances.find((balance) => balance.itemId === item.id)?.onHand ?? '0'
const stockBefore = Number(await onHand())

// A supplier with a fiscal profile; Fiscal indexes its CNPJ from the owner's export.
const supplierTaxId = cnpj()
const supplier = await ok('/parties/parties', {
  method: 'POST',
  body: {
    kind: 'organization',
    taxId: supplierTaxId,
    roles: ['supplier'],
    legalName: 'Fornecedor Smoke Fase 44 LTDA',
    email: 'fornecedor@example.com',
    phone: '1130000000',
    address: 'Rua do Fornecedor, 10, São Paulo',
  },
})
const supplierId = supplier.id ?? supplier.partyId
await ok(`/parties/parties/${supplierId}/fiscal-profile`, {
  method: 'PUT',
  body: {
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
evidence.supplierId = supplierId
await until('Procurement to know the supplier', async () =>
  (await ok('/procurement/suppliers')).some((entry) => (entry.id ?? entry.partyId) === supplierId),
)

// Order 10, receive 6: a partial receipt, captured on the broker for replay.
const broker = await connect(amqpUrl)
const channel = await broker.createChannel()
const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true })
await channel.bindQueue(queue, 'horizon.events', 'procurement.receipt.recorded')
const orderLine = randomUUID()
const order = await ok('/procurement/orders', {
  method: 'POST',
  body: {
    supplierId,
    warehouseId: warehouse.id,
    currency: 'BRL',
    lines: [{ lineId: orderLine, itemId: item.id, quantity: '10', unitPrice: '1000' }],
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
evidence.orderId = orderId
evidence.receiptId = receiptId
const captured = await until('the receipt event on the broker', async () => {
  const message = await channel.get(queue, { noAck: true })
  if (!message) return undefined
  const event = JSON.parse(message.content.toString())
  return event.payload.receiptId === receiptId ? message : undefined
})

// Financial raises the receipt's payable; a second person approves it, then it is posted.
const payable = await until('the receipt payable', async () =>
  (await ok(`/financial/payables?partyId=${supplierId}&limit=100`)).data?.find(
    (title) => title.origin?.documentId === receiptId || title.reference?.startsWith('GR-'),
  ),
)
const categories = (await ok('/financial/categories')).data
const category =
  categories.find((entry) => entry.nature === 'expense' && entry.active !== false) ??
  (await ok('/financial/categories', {
    method: 'POST',
    body: { code: `P44-${Date.now().toString(36)}`.slice(0, 20), name: 'Compras de mercadoria', nature: 'expense' },
  }))
const detail = await ok(`/financial/payables/${payable.id}`)
await ok(`/financial/payables/${payable.id}`, {
  method: 'PUT',
  body: {
    partyId: supplierId,
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
await ok(`/financial/payables/${payable.id}/post`, { method: 'POST', body: {}, key: randomUUID() })
evidence.payableId = payable.id

// The supplier's signed NF-e, imported twice.
const directory = await mkdtemp(join(tmpdir(), 'horizon-phase44-smoke-'))
const xmlPath = join(directory, 'supplier.xml')
const fixture = JSON.parse(
  execFileSync(
    process.execPath,
    [
      join(root, 'fiscal/dist/phase44-supplier-invoice-cli.js'),
      '--supplier-tax-id',
      supplierTaxId,
      '--recipient-tax-id',
      buyerTaxId,
      '--number',
      String(Math.floor(Math.random() * 900_000) + 1),
      '--line',
      `SMK-01|${item.ncm}|6|10.00|${item.name}`,
      '--out',
      xmlPath,
      '--protocol',
    ],
    { encoding: 'utf8', env: { ...process.env, FISCAL_ALLOW_SUPPLIER_FIXTURE: 'true' } },
  ),
)
const xml = await readFile(xmlPath)
await rm(directory, { recursive: true, force: true })
const first = await call('/fiscal/imports', { method: 'POST', body: xml, type: 'application/xml' })
assert.equal(first.status, 201, JSON.stringify(first.body))
const importId = first.body.importId
const again = await call('/fiscal/imports', { method: 'POST', body: xml, type: 'application/xml' })
assert.equal(again.status, 200)
assert.equal(again.body.outcome, 'duplicate')
evidence.importId = importId
evidence.accessKey = fixture.accessKey

const view = await until('Fiscal to propose the receipt', async () => {
  const found = await ok(`/fiscal/imports/${importId}`)
  return found.proposals[0]?.allocations.length > 0 &&
    found.supplier.candidatePartyIds.includes(supplierId)
    ? found
    : undefined
})
assert.deepEqual(view.proposals[0].allocations, [
  { receiptId, receiptLineId: orderLine, quantity: '6' },
])
const key = `phase44-smoke-${randomUUID()}`
const request = {
  supplierPartyId: supplierId,
  lines: view.proposals[0].allocations.map((allocation) => ({ ...allocation, lineNumber: 1 })),
  unmatchedLines: [],
  rememberMappings: true,
}
const committed = await call(`/fiscal/imports/${importId}/reconciliation`, {
  method: 'POST',
  body: request,
  key,
})
assert.equal(committed.status, 201, JSON.stringify(committed.body))
assert.equal(committed.body.decision, 'matched')
const replayed = await call(`/fiscal/imports/${importId}/reconciliation`, {
  method: 'POST',
  body: request,
  key,
})
assert.equal(replayed.status, 200)
assert.equal(replayed.body.id, committed.body.id)
evidence.reconciliationId = committed.body.id
evidence.payableTitleIdsAtCommit = committed.body.payableTitleIds

// Replay the exact receipt event; every consumer must treat it as already seen.
channel.publish('horizon.events', 'procurement.receipt.recorded', captured.content, captured.properties)
await channel.close()
await broker.close()
await new Promise((resolve) => setTimeout(resolve, 5000))

const receipts = await ok(`/procurement/orders/${orderId}/receipts`)
const payables = (await ok(`/financial/payables?partyId=${supplierId}&limit=100`)).data.filter(
  (title) => title.status !== 'cancelled',
)
const stockAfter = Number(await onHand())
evidence.after = {
  receipts: receipts.length ?? receipts.data?.length,
  payables: payables.map((title) => ({ id: title.id, status: title.status, stage: title.stage })),
  stockDelta: stockAfter - stockBefore,
  importStatus: (await ok(`/fiscal/imports/${importId}`)).status,
}
assert.equal(evidence.after.receipts, 1)
assert.equal(payables.filter((title) => title.stage !== 'forecast').length, 1)
assert.equal(evidence.after.stockDelta, 6)
assert.equal(evidence.after.importStatus, 'reconciled')
console.log(JSON.stringify(evidence, null, 2))
