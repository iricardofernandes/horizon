#!/usr/bin/env node
/**
 * Phase 50 local-stack smoke through Kong. A proposal with a good and a service becomes a
 * sales order and a service order; the service order is started, delivered in two parts
 * and accepted; each delivery raises one receivable in Financial and one NFS-e per line in
 * Fiscal (issued at once under the `automatic` policy); the delivered fact replayed under
 * a new event id changes nothing; and cancelling a delivery withdraws its receivable and
 * cancels its NFS-e with event 101101. Nothing moves stock for the service.
 *
 *   node scripts/phase50-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
 *     [--postgres-container horizon-postgres]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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

const operator = execFileSync(
  process.execPath,
  [
    join(root, 'infra/scripts/mint-dev-token.mjs'),
    '--tenant',
    tenantId,
    '--sub',
    randomUUID(),
    ...['parties:admin', 'sales:admin', 'inventory:admin', 'catalog:admin', 'fiscal:admin', 'identity:admin'].flatMap(
      (role) => ['--role', role],
    ),
  ],
  { encoding: 'utf8' },
).trim()

async function call(path, { method = 'GET', body, key = method === 'GET' ? undefined : randomUUID() } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${operator}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  const type = response.headers.get('content-type') ?? ''
  return { status: response.status, body: text && type.includes('json') ? JSON.parse(text) : text }
}

async function ok(path, options) {
  const result = await call(path, options)
  if (result.status >= 400)
    throw new Error(`${options?.method ?? 'GET'} ${path}: HTTP ${result.status} ${JSON.stringify(result.body)}`)
  return result.body
}

async function until(label, probe, timeoutMs = 120_000) {
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

const sql = (database, statement) =>
  execFileSync(
    'docker',
    ['exec', postgresContainer, 'psql', '-U', 'postgres', '-d', database, '-At', '-c', statement],
    { encoding: 'utf8' },
  ).trim()

function checkDigits(base, weightsFor) {
  const digits = [...base]
  for (const weights of weightsFor) {
    const rest = digits.reduce((sum, value, index) => sum + value * weights[index], 0) % 11
    digits.push(rest < 2 ? 0 : 11 - rest)
  }
  return digits.join('')
}
const cnpj = () =>
  checkDigits(
    [...Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)), 0, 0, 0, 1],
    [
      [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
      [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
    ],
  )

const evidence = { checkedAt: new Date().toISOString(), tenantId }
// Work is recorded on the day it was performed where it was performed, as the screen does.
const performedOn = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
const establishmentId = tenantId

// --- a priced Catalog service with its fiscal profile --------------------------------------
const [unit] = (await ok('/catalog/units')).data
const service = await ok('/catalog/items', {
  method: 'POST',
  body: { kind: 'service', sku: `SRV50-${Date.now()}`, name: 'Implantação assistida', unitId: unit.id },
})
const serviceId = service.id ?? service.itemId
const priceLists = (await ok('/catalog/price-lists')).data ?? (await ok('/catalog/price-lists'))
const priceList = priceLists.find((row) => row.currency === 'BRL')
await ok(`/catalog/price-lists/${priceList.id}/prices/${serviceId}`, {
  method: 'PUT',
  body: { amount: '120000', currency: 'BRL' },
})
await until('Sales to project the service with its price', async () =>
  sql('horizon_sales', `select kind from catalog_items where tenant_id = '${tenantId}' and item_id = '${serviceId}' and unit_price is not null`) === 'service',
)
await until('the service profile (Catalog item visible to Fiscal)', async () => {
  const saved = await call('/fiscal/service-profiles', {
    method: 'POST',
    body: {
      itemId: serviceId,
      nationalTaxCode: '010101',
      nbsCode: '115022000',
      issTaxation: '1',
      description: 'Implantação assistida de sistema',
      effectiveFrom: '2026-01-01',
      reason: 'Classificação revisada no smoke da fase 50',
    },
  })
  if (saved.status >= 400) throw new Error(JSON.stringify(saved.body))
  return saved.body
})
const simulation = JSON.parse(execFileSync('docker', ['exec', 'horizon-fiscal', 'printenv', 'FISCAL_SIMULATION_PROFILE_JSON'], { encoding: 'utf8' }))
const goodId = Object.keys(simulation.lineFacts)[0]

// --- a customer with a national fiscal profile ---------------------------------------------
const party = await ok('/parties/parties', {
  method: 'POST',
  body: {
    kind: 'organization',
    taxId: cnpj(),
    roles: ['customer'],
    legalName: 'Cliente de Serviços Smoke Fase 50 LTDA',
    email: `servicos50-${Date.now()}@example.com`,
    phone: '11999990000',
    address: 'Avenida Paulista, 1000, São Paulo',
  },
})
const customerId = party.id ?? party.partyId
await ok(`/parties/parties/${customerId}/fiscal-profile`, {
  method: 'PUT',
  body: {
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
      municipalityCode: '3550308',
      state: 'SP',
      postalCode: '01310100',
      country: 'BR',
    },
  },
})
await until('Sales to project the customer', async () =>
  (await ok('/sales/customers')).some((row) => (row.id ?? row.partyId) === customerId),
)

// --- NFS-e of delivered services are issued at once for this establishment ------------------
await ok(`/fiscal/service-issuance-policies/${establishmentId}`, {
  method: 'PUT',
  body: { mode: 'automatic', series: 50, reason: 'Emissão automática para o smoke da fase 50' },
})

// --- a mixed proposal becomes a sales order and a service order ----------------------------
const goodLine = randomUUID()
const serviceLine = randomUUID()
const quote = await ok('/sales/quotes', {
  method: 'POST',
  body: {
    customerId,
    lines: [
      { lineId: goodLine, itemId: goodId, quantity: '1' },
      { lineId: serviceLine, itemId: serviceId, quantity: '2' },
    ],
    terms: { discount: '1000', paymentTermDays: [0, 30] },
  },
})
const quoteId = quote.quoteId ?? quote.id
await ok(`/sales/quotes/${quoteId}/send`, { method: 'POST' })
await ok(`/sales/quotes/${quoteId}/accept`, { method: 'POST' })
const [warehouse] = await ok('/inventory/warehouses')
const conversionKey = randomUUID()
const conversion = await ok(`/sales/quotes/${quoteId}/order`, {
  method: 'POST',
  body: { fulfillmentWarehouseId: warehouse.id },
  key: conversionKey,
})
assert.ok(conversion.orderId && conversion.serviceOrderId, JSON.stringify(conversion))
assert.deepEqual(
  await ok(`/sales/quotes/${quoteId}/order`, { method: 'POST', body: { fulfillmentWarehouseId: warehouse.id }, key: conversionKey }),
  conversion,
)
const placed = JSON.parse(
  sql('horizon_sales', `select payload from outbox where tenant_id = '${tenantId}' and event_type = 'sales.order.placed' and payload->>'orderId' = '${conversion.orderId}'`),
)
assert.deepEqual(placed.lines.map((line) => line.itemId), [goodId])
const { serviceOrderId } = conversion
const opened = await ok(`/sales/service-orders/${serviceOrderId}`)
assert.equal(opened.status, 'scheduled')
assert.equal(opened.quoteId, quoteId)
evidence.conversion = {
  quoteId,
  orderId: conversion.orderId,
  serviceOrderId,
  serviceOrder: { net: opened.net, discount: opened.discount, total: opened.total },
}

// --- started, delivered in two parts, accepted ---------------------------------------------
await ok(`/sales/service-orders/${serviceOrderId}/start`, { method: 'POST' })
const first = await ok(`/sales/service-orders/${serviceOrderId}/deliveries`, {
  method: 'POST',
  body: { lines: [{ lineId: serviceLine, quantity: '1' }], performedOn },
})
const second = await ok(`/sales/service-orders/${serviceOrderId}/deliveries`, {
  method: 'POST',
  body: { performedOn },
})
assert.equal(second.status, 'completed')
await ok(`/sales/service-orders/${serviceOrderId}/accept`, { method: 'POST' })
const accepted = await ok(`/sales/service-orders/${serviceOrderId}`)
assert.equal(accepted.status, 'accepted')
assert.equal(BigInt(first.value) + BigInt(second.value), BigInt(accepted.total))
assert.equal(accepted.billed, accepted.total)
const deliveries = [first.deliveryId, second.deliveryId]
evidence.deliveries = { values: [first.value, second.value], total: accepted.total, deliveries }

// --- one receivable per delivery, one NFS-e per delivered line ------------------------------
const titlesOf = (deliveryId) =>
  sql('horizon_financial', `select count(*) || ':' || coalesce(string_agg(status, ','), '') from titles where tenant_id = '${tenantId}' and origin_type = 'sales-service-delivery' and origin_document_id = '${deliveryId}'`)
for (const deliveryId of deliveries)
  await until(`the receivable of delivery ${deliveryId}`, async () => titlesOf(deliveryId) === '1:draft')
const intakesOf = async (deliveryId) =>
  (await ok('/fiscal/service-intakes')).data.filter((intake) => intake.deliveryId === deliveryId)
const documents = {}
for (const deliveryId of deliveries) {
  const [intake] = await until(`the NFS-e of delivery ${deliveryId}`, async () => {
    const found = await intakesOf(deliveryId)
    if (found[0]?.status === 'blocked') throw new Error(found[0].reason)
    return found[0]?.status === 'issuing' ? found : undefined
  })
  const document = await until('NFS-e generation', async () => {
    const read = await ok(`/fiscal/service-documents/${intake.documentId}`)
    if (read.status === 'rejected') throw new Error(`NFS-e rejected: ${intake.documentId}`)
    return read.status === 'authorized' ? read : undefined
  })
  assert.equal(document.series, 50)
  assert.equal(intake.sourceKey.module, 'sales')
  assert.equal(intake.sourceKey.documentType, 'service-delivery')
  documents[deliveryId] = { documentId: document.id, number: document.number, nfseNumber: document.nfseNumber }
}
evidence.effects = { titles: deliveries.map(titlesOf), documents }

// --- the delivered fact replayed under a new event id changes nothing ------------------------
const replayId = randomUUID()
sql(
  'horizon_sales',
  `begin; select set_config('app.current_tenant', '${tenantId}', true);
   insert into outbox (id, tenant_id, event_id, event_type, event_version, occurred_at, trace_id, payload)
   select '${replayId}', tenant_id, '${replayId}', event_type, event_version, now(), trace_id, payload
   from outbox where tenant_id = '${tenantId}' and event_type = 'sales.service.delivered'
     and payload->>'deliveryId' = '${first.deliveryId}'; commit;`,
)
await until('Financial and Fiscal to consume the replay', async () =>
  sql('horizon_financial', `select count(*) from inbox where tenant_id = '${tenantId}' and event_id = '${replayId}'`) === '1' &&
  sql('horizon_fiscal', `select count(*) from inbox where tenant_id = '${tenantId}' and event_id = '${replayId}'`) === '1',
)
assert.equal(titlesOf(first.deliveryId), '1:draft')
assert.equal((await intakesOf(first.deliveryId)).length, 1)
assert.equal(
  sql('horizon_fiscal', `select count(*) from fiscal_service_origins where tenant_id = '${tenantId}' and source_module = 'sales' and source_id = '${(await intakesOf(first.deliveryId))[0].sourceKey.id}'`),
  '1',
)
evidence.replay = { eventId: replayId, titles: titlesOf(first.deliveryId), intakes: 1 }

// --- cancelling a delivery withdraws the receivable and cancels the NFS-e -------------------
await ok(`/sales/service-orders/${serviceOrderId}/deliveries/${first.deliveryId}/cancel`, {
  method: 'POST',
  body: { reason: 'A primeira etapa não foi prestada' },
})
await until('the receivable to be withdrawn', async () => titlesOf(first.deliveryId) === '1:cancelled')
const withdrawn = await until('the NFS-e to be cancelled', async () => {
  const [intake] = await intakesOf(first.deliveryId)
  if (intake?.status === 'cancellation-refused') throw new Error(intake.reason)
  return intake?.status === 'withdrawn' ? intake : undefined
})
assert.equal((await ok(`/fiscal/service-documents/${withdrawn.documentId}`)).status, 'cancelled')
const reopened = await ok(`/sales/service-orders/${serviceOrderId}`)
assert.equal(reopened.status, 'in_progress')
assert.equal(reopened.billed, second.value)
assert.equal(titlesOf(second.deliveryId), '1:draft')
evidence.cancellation = {
  deliveryId: first.deliveryId,
  title: titlesOf(first.deliveryId),
  nfse: 'cancelled',
  serviceOrder: reopened.status,
}

await ok(`/fiscal/service-issuance-policies/${establishmentId}`, {
  method: 'PUT',
  body: { mode: 'review', series: 1, reason: 'Revisão por pessoa restaurada após o smoke' },
})
evidence.result = 'passed'
console.log(JSON.stringify(evidence, null, 2))
