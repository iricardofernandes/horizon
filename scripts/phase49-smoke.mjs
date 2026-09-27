#!/usr/bin/env node
/**
 * Phase 49 local-stack smoke through Kong. A priced Catalog service reaches Sales with its
 * kind; a proposal prices a good and the service together; a goods order still confirms
 * and ships; and the service is refused, with its reason, both in a sales order and in the
 * conversion of the accepted proposal, before Inventory is asked for anything.
 *
 *   node scripts/phase49-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
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
    ...['parties:admin', 'sales:admin', 'inventory:admin', 'catalog:admin', 'fiscal:admin'].flatMap(
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

async function until(label, probe, timeoutMs = 60_000) {
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

const sql = (statement) =>
  execFileSync(
    'docker',
    ['exec', postgresContainer, 'psql', '-U', 'postgres', '-d', 'horizon_sales', '-At', '-c', statement],
    { encoding: 'utf8' },
  ).trim()

/** Sales answers conflicts as `{ message }`; RFC 9457 bodies say `detail`. */
const reasonOf = (body) => body.detail ?? body.message

const evidence = { checkedAt: new Date().toISOString(), tenantId }

// --- a priced Catalog service reaches Sales with its kind ----------------------------------
const [unit] = (await ok('/catalog/units')).data
const service = await ok('/catalog/items', {
  method: 'POST',
  body: { kind: 'service', sku: `SRV49-${Date.now()}`, name: 'Implantação assistida', unitId: unit.id },
})
const serviceId = service.id ?? service.itemId
const priceLists = (await ok('/catalog/price-lists')).data ?? (await ok('/catalog/price-lists'))
const priceList =
  priceLists.find((row) => row.currency === 'BRL') ??
  (await ok('/catalog/price-lists', { method: 'POST', body: { name: 'Tabela padrão', currency: 'BRL' } }))
await ok(`/catalog/price-lists/${priceList.id}/prices/${serviceId}`, {
  method: 'PUT',
  body: { amount: '150000', currency: 'BRL' },
})
await until('Sales to project the service with its kind', async () =>
  sql(`select kind from catalog_items where tenant_id = '${tenantId}' and item_id = '${serviceId}' and unit_price is not null`) === 'service',
)
const profile = JSON.parse(execFileSync('docker', ['exec', 'horizon-fiscal', 'printenv', 'FISCAL_SIMULATION_PROFILE_JSON'], { encoding: 'utf8' }))
const goodId = Object.keys(profile.lineFacts)[0]
assert.equal(sql(`select kind from catalog_items where tenant_id = '${tenantId}' and item_id = '${goodId}'`), 'product')
evidence.items = { serviceId, goodId }

// --- a customer and a proposal with a good and a service -----------------------------------
const customers = await ok('/sales/customers')
const customer = customers.find((entry) => entry.active !== false) ?? customers[0]
const customerId = customer.id ?? customer.partyId
const goodLine = randomUUID()
const serviceLine = randomUUID()
const quote = await ok('/sales/quotes', {
  method: 'POST',
  body: {
    customerId,
    lines: [
      { lineId: goodLine, itemId: goodId, quantity: '1' },
      { lineId: serviceLine, itemId: serviceId, quantity: '1' },
    ],
  },
})
const quoteId = quote.quoteId ?? quote.id
await ok(`/sales/quotes/${quoteId}/send`, { method: 'POST' })
await ok(`/sales/quotes/${quoteId}/accept`, { method: 'POST' })
const read = await ok(`/sales/quotes/${quoteId}`)
assert.deepEqual(
  Object.fromEntries(read.lines.map((line) => [line.lineId, line.kind])),
  { [goodLine]: 'product', [serviceLine]: 'service' },
)
evidence.proposal = { quoteId, total: read.total, kinds: read.lines.map((line) => line.kind).sort() }

// --- the accepted proposal is not converted into a sales order ------------------------------
const [warehouse] = await ok('/inventory/warehouses')
const placedBefore = sql(`select count(*) from outbox where tenant_id = '${tenantId}' and event_type = 'sales.order.placed'`)
const conversion = await call(`/sales/quotes/${quoteId}/order`, {
  method: 'POST',
  body: { fulfillmentWarehouseId: warehouse.id },
})
assert.equal(conversion.status, 409, JSON.stringify(conversion.body))
assert.match(reasonOf(conversion.body), /^service lines of a proposal are delivered by a service order/)
assert.ok(reasonOf(conversion.body).includes(serviceLine))
const after = await ok(`/sales/quotes/${quoteId}`)
assert.equal(after.status, 'accepted')
assert.equal(after.orderId, null)

// --- a sales order with the service is refused; a goods order still confirms ---------------
const refused = await call('/sales/orders', {
  method: 'POST',
  body: {
    customerId,
    fulfillmentWarehouseId: warehouse.id,
    currency: 'BRL',
    lines: [{ lineId: randomUUID(), itemId: serviceId, quantity: '1' }],
  },
})
assert.equal(refused.status, 409, JSON.stringify(refused.body))
assert.match(reasonOf(refused.body), /^service items are delivered by a service order/)
assert.equal(
  sql(`select count(*) from outbox where tenant_id = '${tenantId}' and event_type = 'sales.order.placed'`),
  placedBefore,
)
const goodsLine = randomUUID()
const goods = await ok('/sales/orders', {
  method: 'POST',
  body: {
    customerId,
    fulfillmentWarehouseId: warehouse.id,
    currency: 'BRL',
    lines: [{ lineId: goodsLine, itemId: goodId, quantity: '1' }],
  },
})
const orderId = goods.orderId ?? goods.id
const confirmed = await until('the goods order to confirm', async () => {
  const order = await ok(`/sales/orders/${orderId}`)
  return order.status === 'confirmed' ? order : undefined
})
assert.equal(confirmed.requestedLines[0].kind, 'product')
const picked = await ok('/sales/shipments', {
  method: 'POST',
  body: { orderId, lines: [{ lineId: goodsLine, quantity: '1' }] },
})
const shipmentId = picked.shipmentId ?? picked.id
await ok(`/sales/shipments/${shipmentId}/pack`, { method: 'POST', body: {} })
await ok(`/sales/shipments/${shipmentId}/dispatch`, { method: 'POST', body: {} })
evidence.orders = {
  conversionRefused: reasonOf(conversion.body),
  serviceOrderRefused: reasonOf(refused.body),
  goodsOrderId: orderId,
  goodsShipmentId: shipmentId,
}
console.log(JSON.stringify(evidence, null, 2))
