#!/usr/bin/env node
/**
 * Phase 58 local-stack smoke through Kong: "convert to quote" end to end.
 *
 * A prospect account with a contact and an opportunity (with a source) is granted
 * `customer` in Parties; once Sales lists the customer, a quote is written for the
 * opportunity. The opportunity then changes owner, the offer is renegotiated and accepted.
 * Both versions keep the owner and source frozen by the first one, a body trying to set the
 * attribution is refused, CRM links the quote and converts the opportunity — won at the
 * quote total, published as `crm.opportunity.converted` — and refuses to reopen it.
 *
 *   node scripts/phase58-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
 *     [--rabbitmq-url http://localhost:15672]
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
const rabbitUrl = flag('rabbitmq-url', 'http://localhost:15672').replace(/\/$/, '')

const token = (sub, ...roles) =>
  execFileSync(
    process.execPath,
    [
      join(root, 'infra/scripts/mint-dev-token.mjs'),
      '--tenant',
      tenantId,
      '--sub',
      sub,
      ...roles.flatMap((role) => ['--role', role]),
    ],
    { encoding: 'utf8' },
  ).trim()

const operator = token(randomUUID(), 'parties:admin', 'crm:manager', 'sales:admin', 'identity:owner')

async function call(path, { method = 'GET', body, key } = {}) {
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

const sql = (database, statement) =>
  execFileSync('docker', ['exec', 'horizon-postgres', 'psql', '-U', 'postgres', '-d', database, '-At', '-c', statement], {
    encoding: 'utf8',
  }).trim()

// --- a probe queue for the quote and conversion facts, removed at the end -------------------
const rabbitPassword = execFileSync('docker', ['exec', 'horizon-rabbitmq', 'printenv', 'RABBITMQ_DEFAULT_PASS'], {
  encoding: 'utf8',
}).trim()
const rabbitAuth = `Basic ${Buffer.from(`horizon:${rabbitPassword}`).toString('base64')}`
const rabbit = async (path, method = 'GET', body) => {
  const response = await fetch(`${rabbitUrl}/api${path}`, {
    method,
    headers: { authorization: rabbitAuth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`RabbitMQ ${method} ${path}: HTTP ${response.status}`)
  const text = await response.text()
  return text ? JSON.parse(text) : null
}
const probe = `smoke.phase58.${Date.now()}`
await rabbit(`/queues/%2F/${probe}`, 'PUT', { durable: true, auto_delete: false })
for (const routingKey of ['sales.quote.#', 'crm.opportunity.#'])
  await rabbit(`/bindings/%2F/e/horizon.events/q/${probe}`, 'POST', { routing_key: routingKey })
const messagesAbout = async (ids) => {
  const got = await rabbit(`/queues/%2F/${probe}/get`, 'POST', { count: 200, ackmode: 'ack_requeue_true', encoding: 'auto' })
  return got
    .map((message) => ({ type: message.routing_key, payload: JSON.parse(message.payload).payload }))
    .filter(({ payload }) => ids.includes(payload.opportunityId) || ids.includes(payload.attribution?.opportunityId))
}

const run = Date.now().toString(36)
const evidence = { checkedAt: new Date().toISOString(), tenantId }
try {
  // --- the CRM side: a prospect, a contact, an opportunity with a source -------------------
  const owners = (await ok('/crm/owners')).data.filter((owner) => owner.active)
  const [ownerId, nextOwnerId] = owners.map((owner) => owner.userId)
  assert.ok(ownerId && nextOwnerId, 'two active owners (phase 55 backfill)')
  const { partyId: accountId } = await ok('/parties/parties', {
    method: 'POST',
    body: { kind: 'organization', legalName: `Globex ${run} Ltda`, document: { type: 'none' }, roles: ['prospect'] },
  })
  await until('CRM to project the account', async () => (await call(`/crm/accounts/${accountId}`)).status === 200)
  await ok(`/crm/accounts/${accountId}/contacts`, {
    method: 'POST',
    key: randomUUID(),
    body: { name: 'Hank Scorpio', lawfulBasis: 'legitimate-interest' },
  })
  const { entryId: sourceId } = await ok('/crm/sources', { method: 'POST', key: randomUUID(), body: { name: `Evento ${run}` } })
  const { pipelineId } = await ok('/crm/pipelines', {
    method: 'POST',
    key: randomUUID(),
    body: { name: `Vendas 58 ${run}`, stages: [{ name: 'Proposta', probabilityBps: 5000 }] },
  })
  const [stageId] = (await ok(`/crm/pipelines/${pipelineId}`)).stages.map((stage) => stage.id)
  const { opportunityId } = await ok('/crm/opportunities', {
    method: 'POST',
    key: randomUUID(),
    body: {
      accountId,
      ownerId,
      pipelineId,
      stageId,
      sourceId,
      title: `Globex ${run}`,
      expectedValue: { amount: '500000', currency: 'BRL' },
      expectedCloseOn: '2026-12-20',
    },
  })
  await until('Sales to project the opportunity', async () =>
    sql('horizon_sales', `select status from opportunity_projections where tenant_id = '${tenantId}' and id = '${opportunityId}'`) === 'open',
  )

  // --- convert to quote: customer in Parties, wait for Sales, then the quote ------------------
  const tooEarly = await call('/sales/quotes', {
    method: 'POST',
    key: randomUUID(),
    body: { customerId: accountId, opportunityId, lines: [{ lineId: randomUUID(), itemId: randomUUID(), quantity: '1' }] },
  })
  assert.equal(tooEarly.status, 404, 'a prospect is not a Sales customer yet')
  await ok(`/parties/parties/${accountId}`, {
    method: 'PUT',
    body: {
      legalName: `Globex ${run} Ltda`,
      email: `compras-${run}@globex.example`,
      phone: '+5511988887777',
      address: 'Avenida Paulista, 1000, São Paulo',
    },
  })
  await ok(`/parties/parties/${accountId}/roles/customer`, { method: 'PUT', body: { operation: 'grant' } })
  await until('Sales to list the customer', async () => (await ok('/sales/customers')).some((row) => row.id === accountId))

  const itemId = sql(
    'horizon_sales',
    `select item_id from catalog_items where tenant_id = '${tenantId}' and active = 1 and currency = 'BRL' and unit_price > 0 order by item_id limit 1`,
  )
  assert.ok(itemId, 'a priced catalogue item in Sales')
  const lines = (quantity) => [{ lineId: randomUUID(), itemId, quantity }]
  const smuggled = await call('/sales/quotes', {
    method: 'POST',
    key: randomUUID(),
    body: { customerId: accountId, opportunityId, ownerId: nextOwnerId, lines: lines('1') },
  })
  assert.equal(smuggled.status, 400, 'Sales takes no attribution from the body')
  const { quoteId: first } = await ok('/sales/quotes', {
    method: 'POST',
    key: randomUUID(),
    body: { customerId: accountId, opportunityId, lines: lines('1') },
  })
  await ok(`/sales/quotes/${first}/send`, { method: 'POST' })

  // --- the opportunity changes hands; the offer is renegotiated and accepted ------------------
  await ok(`/crm/opportunities/${opportunityId}/owner`, { method: 'POST', body: { ownerId: nextOwnerId } })
  await until('Sales to see the new owner', async () =>
    sql('horizon_sales', `select owner_id from opportunity_projections where tenant_id = '${tenantId}' and id = '${opportunityId}'`) === nextOwnerId,
  )
  const { quoteId: second } = await ok(`/sales/quotes/${first}/revise`, {
    method: 'POST',
    key: randomUUID(),
    body: { lines: lines('3') },
  })
  await ok(`/sales/quotes/${second}/send`, { method: 'POST' })
  await ok(`/sales/quotes/${second}/accept`, { method: 'POST' })

  const attribution = { opportunityId, ownerId, sourceId }
  const versions = [await ok(`/sales/quotes/${first}`), await ok(`/sales/quotes/${second}`)]
  assert.deepEqual(versions.map((quote) => quote.attribution), [attribution, attribution])
  const total = versions[1].total

  // --- CRM links the quote and converts the opportunity ---------------------------------------
  const detail = await until('CRM to convert the opportunity', async () => {
    const found = await ok(`/crm/opportunities/${opportunityId}`)
    return found.status === 'won' ? found : undefined
  })
  assert.deepEqual(detail.conversion, { quoteId: second, quoteRoot: first, quoteVersion: 2 })
  assert.equal(detail.expectedValue.amount, total)
  assert.deepEqual(detail.quotes.map((quote) => [quote.quoteRoot, quote.quoteVersion, quote.status]), [[first, 2, 'accepted']])
  assert.deepEqual(
    detail.history.map((recorded) => recorded.fact.type),
    ['created', 'owner-changed', 'converted'],
  )
  const reopen = await call(`/crm/opportunities/${opportunityId}/reopen`, { method: 'POST', body: { stageId } })
  assert.equal(reopen.status, 409)

  // --- the bus: every quote event attributed, the conversion with the frozen attribution -----
  const messages = await until('the conversion on the bus', async () => {
    const found = await messagesAbout([opportunityId])
    return found.some(({ type }) => type === 'crm.opportunity.converted') ? found : undefined
  })
  const quoteEvents = messages.filter(({ type }) => type.startsWith('sales.quote.'))
  assert.deepEqual(quoteEvents.map(({ type }) => type), ['sales.quote.sent', 'sales.quote.sent', 'sales.quote.accepted'])
  for (const { payload } of quoteEvents) assert.deepEqual(payload.attribution, attribution)
  const converted = messages.find(({ type }) => type === 'crm.opportunity.converted').payload
  assert.equal(converted.quoteId, second)
  assert.equal(converted.value.amount, total)
  assert.equal(converted.sourceId, sourceId)
  // The conversion reads CRM's own owner, who owns the opportunity now; the quote keeps who
  // owned it when the offer was made.
  assert.equal(converted.ownerId, nextOwnerId)
  const crmTypes = messages.filter(({ type }) => type.startsWith('crm.')).map(({ type }) => type.replace('crm.opportunity.', ''))
  assert.deepEqual(crmTypes, ['created', 'owner-changed', 'won', 'converted'])

  evidence.conversion = {
    accountId,
    opportunityId,
    quotes: { first, second, total },
    attribution,
    crmEvents: crmTypes,
    reopen: reopen.status,
    smuggledAttribution: smuggled.status,
    beforeCustomer: tooEarly.status,
  }
} finally {
  await rabbit(`/queues/%2F/${probe}`, 'DELETE').catch(() => undefined)
}

console.log(JSON.stringify(evidence, null, 2))
