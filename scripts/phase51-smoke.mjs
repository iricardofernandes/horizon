#!/usr/bin/env node
/**
 * Phase 51 local-stack smoke through Kong. A monthly service contract is drafted,
 * activated, amended from a later period, suspended and resumed, renewed with a
 * readjustment and cancelled; the period schedule is read back after each change, and
 * every period that had begun, or came before the change, keeps its revision and amount.
 *
 *   node scripts/phase51-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
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
    ...['sales:admin', 'catalog:admin'].flatMap((role) => ['--role', role]),
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
  while (Date.now() < deadline) {
    if (await probe()) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const sql = (statement) =>
  execFileSync(
    'docker',
    ['exec', postgresContainer, 'psql', '-U', 'postgres', '-d', 'horizon_sales', '-At', '-c', statement],
    { encoding: 'utf8' },
  ).trim()

/** The first day of the month `months` from the current UTC month. */
const month = (months) => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1)).toISOString().slice(0, 10)
}
const dayBefore = (date) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
const evidence = { checkedAt: new Date().toISOString(), tenantId }

// --- a priced service and a customer ---------------------------------------------------------
const [unit] = (await ok('/catalog/units')).data
const service = await ok('/catalog/items', {
  method: 'POST',
  body: { kind: 'service', sku: `SUP51-${Date.now()}`, name: 'Suporte técnico mensal', unitId: unit.id },
})
const serviceId = service.id ?? service.itemId
const priceLists = (await ok('/catalog/price-lists')).data ?? (await ok('/catalog/price-lists'))
const priceList = priceLists.find((row) => row.currency === 'BRL')
await ok(`/catalog/price-lists/${priceList.id}/prices/${serviceId}`, {
  method: 'PUT',
  body: { amount: '90000', currency: 'BRL' },
})
await until('Sales to project the service with its price', async () =>
  sql(`select kind from catalog_items where tenant_id = '${tenantId}' and item_id = '${serviceId}' and unit_price is not null`) === 'service',
)
const customer = (await ok('/sales/customers')).find((row) => row.status === 'active')
const customerId = customer.id ?? customer.partyId

// --- drafted and activated ---------------------------------------------------------------------
const startsOn = month(1)
const endsOn = dayBefore(month(13))
const lineId = randomUUID()
const { contractId } = await ok('/sales/contracts', {
  method: 'POST',
  body: {
    customerId,
    lines: [{ lineId, itemId: serviceId, quantity: '1' }],
    recurrence: 'monthly',
    startsOn,
    endsOn,
    billingDay: 10,
    paymentTermDays: [15],
    notes: 'Contrato do smoke da fase 51',
  },
})
const activated = await ok(`/sales/contracts/${contractId}/activate`, { method: 'POST' })
assert.equal(activated.status, 'active')
const schedule = async () =>
  (await ok(`/sales/contracts/${contractId}/schedule?from=${startsOn}&to=${month(40)}`)).periods
const initial = await schedule()
assert.equal(initial.length, 12)
assert.equal(initial[0].competence, startsOn.slice(0, 7))
assert.equal(initial[0].billingOn, `${startsOn.slice(0, 7)}-10`)
assert.ok(initial.every((period) => period.revision === 1 && period.amount === '90000'))

// --- an amendment from a later period leaves the earlier ones as they were -----------------
const past = await call(`/sales/contracts/${contractId}/amendments`, {
  method: 'POST',
  body: { effectiveFrom: month(0), lines: [{ lineId, itemId: serviceId, quantity: '2' }], recurrence: 'monthly', reason: 'Tentativa de retroagir' },
})
assert.equal(past.status, 409, JSON.stringify(past.body))
const amendment = await ok(`/sales/contracts/${contractId}/amendments`, {
  method: 'POST',
  body: {
    effectiveFrom: month(3),
    lines: [{ lineId, itemId: serviceId, quantity: '2', unitPrice: '85000' }],
    recurrence: 'monthly',
    reason: 'Segundo posto de atendimento a partir do terceiro mês',
  },
})
assert.equal(amendment.revision, 2)
const amended = await schedule()
assert.deepEqual(amended.slice(0, 2), initial.slice(0, 2))
assert.ok(amended.slice(2).every((period) => period.revision === 2 && period.amount === '170000'))

// --- a suspension removes exactly the periods it covers -----------------------------------
await ok(`/sales/contracts/${contractId}/suspensions`, {
  method: 'POST',
  body: { from: month(5), reason: 'Obra no escritório do cliente' },
})
await ok(`/sales/contracts/${contractId}/resume`, { method: 'POST', body: { at: month(7) } })
const suspended = await schedule()
assert.deepEqual(
  suspended.filter((period) => !period.billable).map((period) => period.competence),
  [month(5).slice(0, 7), month(6).slice(0, 7)],
)
assert.equal(suspended.filter((period) => period.billable).length, 10)
assert.deepEqual(
  suspended.map(({ billable, excluded, ...period }) => period),
  amended.map(({ billable, excluded, ...period }) => period),
)

// --- a renewal continues with no gap and no overlap, readjusted --------------------------
const renewal = await ok(`/sales/contracts/${contractId}/renewals`, {
  method: 'POST',
  body: { readjustmentBasisPoints: 450, reason: 'Renovação anual com reajuste de 4,5%' },
})
assert.equal(renewal.endsOn, dayBefore(month(25)))
const renewed = await schedule()
assert.equal(renewed.length, 24)
for (let index = 1; index < renewed.length; index += 1)
  assert.equal(renewed[index].startsOn, new Date(Date.parse(`${renewed[index - 1].endsOn}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10))
assert.deepEqual(renewed.slice(0, 12), suspended)
assert.equal(renewed[12].revision, 3)
assert.equal(renewed[12].amount, '177650')

// --- cancelled from a later period ---------------------------------------------------------
await ok(`/sales/contracts/${contractId}/cancel`, {
  method: 'POST',
  body: { from: month(19), reason: 'Cliente encerra a filial' },
})
const cancelled = await schedule()
assert.deepEqual(cancelled.slice(0, 18), renewed.slice(0, 18))
assert.ok(cancelled.slice(18).every((period) => period.excluded === 'cancelled'))
const read = await ok(`/sales/contracts/${contractId}`)
assert.deepEqual(read.revisions.map((revision) => revision.kind), ['initial', 'amendment', 'renewal'])
const events = sql(
  `select string_agg(event_type, ',' order by created_at) from outbox where tenant_id = '${tenantId}' and payload->>'contractId' = '${contractId}'`,
)
assert.equal(
  events,
  'sales.contract.activated,sales.contract.amended,sales.contract.suspended,sales.contract.suspended,sales.contract.amended,sales.contract.cancelled',
)
evidence.contract = {
  contractId,
  startsOn,
  endsOn: renewal.endsOn,
  revisions: read.revisions.map((revision) => `${revision.number}:${revision.kind}:${revision.effectiveFrom}`),
  billable: cancelled.filter((period) => period.billable).length,
  suspended: cancelled.filter((period) => period.excluded === 'suspended').map((period) => period.competence),
  cancelledFrom: month(19),
  amounts: [...new Set(cancelled.map((period) => period.amount))],
  events: events.split(',').length,
}
evidence.result = 'passed'
console.log(JSON.stringify(evidence, null, 2))
