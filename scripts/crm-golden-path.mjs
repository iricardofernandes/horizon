#!/usr/bin/env node
/**
 * The CRM golden path on the local stack, through Kong only (Phase 60).
 *
 * A foreign prospect and a prospect without a document each get a contact and an
 * opportunity. The foreign one moves through its stages, gets a task whose reminder fires
 * once, and is converted into a quote: its account becomes a customer, Sales lists it, the
 * quote is written for the opportunity, renegotiated after the opportunity changes hands,
 * and accepted. The source and the owner are checked on every step. The other opportunity
 * is lost. A metrics rebuild then leaves every number where it was.
 *
 * The run is repeatable: everything it creates is named after the run.
 *
 *   node scripts/crm-golden-path.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
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

const operator = execFileSync(
  process.execPath,
  [
    join(root, 'infra/scripts/mint-dev-token.mjs'),
    '--tenant',
    tenantId,
    '--sub',
    randomUUID(),
    ...['parties:admin', 'crm:manager', 'sales:admin'].flatMap((role) => ['--role', role]),
  ],
  { encoding: 'utf8' },
).trim()

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

const sql = (database, statement) =>
  execFileSync('docker', ['exec', 'horizon-postgres', 'psql', '-U', 'postgres', '-d', database, '-At', '-c', statement], {
    encoding: 'utf8',
  }).trim()

// --- a probe queue for what CRM and Sales publish, removed at the end -----------------------
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
const probe = `golden.crm.${Date.now()}`
await rabbit(`/queues/%2F/${probe}`, 'PUT', { durable: true, auto_delete: false })
for (const routingKey of ['crm.#', 'sales.quote.#'])
  await rabbit(`/bindings/%2F/e/horizon.events/q/${probe}`, 'POST', { routing_key: routingKey })
const published = async () =>
  (await rabbit(`/queues/%2F/${probe}/get`, 'POST', { count: 500, ackmode: 'ack_requeue_true', encoding: 'auto' })).map(
    (message) => ({ type: message.routing_key, payload: JSON.parse(message.payload).payload }),
  )

const run = Date.now().toString(36)
const evidence = { checkedAt: new Date().toISOString(), tenantId, run }
try {
  // --- two prospects the CRM must not limit: a foreign company and one without a document ---
  const prospect = (legalName, document) =>
    ok('/parties/parties', {
      method: 'POST',
      body: {
        kind: 'organization',
        legalName,
        document,
        roles: ['prospect'],
        email: `compras-${run}-${document.type}@example.com`,
        phone: `+49301${String(Date.now()).slice(-7)}`,
        address: document.type === 'foreign' ? 'Friedrichstraße 10, Berlin' : 'Rua Um, 42, São Paulo',
      },
    })
  const { partyId: foreignId } = await prospect(`Hooli GmbH ${run}`, {
    type: 'foreign',
    country: 'DE',
    number: `DE${run.toUpperCase()}`,
  })
  const { partyId: undocumentedId } = await prospect(`Pied Piper ${run} Ltda`, { type: 'none' })
  for (const id of [foreignId, undocumentedId])
    await until('CRM to project the prospect', async () => (await call(`/crm/accounts/${id}`)).status === 200)
  const foreign = await ok(`/crm/accounts/${foreignId}`)
  assert.equal(foreign.documentType, 'foreign')
  assert.equal(foreign.documentCountry, 'DE')
  assert.equal((await ok(`/crm/accounts/${undocumentedId}`)).documentType, 'none')
  for (const [id, name] of [
    [foreignId, 'Gavin Belson'],
    [undocumentedId, 'Richard Hendricks'],
  ])
    await ok(`/crm/accounts/${id}/contacts`, {
      method: 'POST',
      key: randomUUID(),
      body: { name, jobTitle: 'Diretor', lawfulBasis: 'legitimate-interest' },
    })

  // --- settings and the two opportunities ----------------------------------------------------
  const owners = (await ok('/crm/owners')).data.filter((owner) => owner.active).map((owner) => owner.userId)
  const [ownerId, nextOwnerId] = owners
  assert.ok(ownerId && nextOwnerId, 'two active owners')
  const { pipelineId } = await ok('/crm/pipelines', {
    method: 'POST',
    key: randomUUID(),
    body: {
      name: `Golden ${run}`,
      stages: [
        { name: 'Qualificação', probabilityBps: 1000 },
        { name: 'Proposta', probabilityBps: 5000 },
        { name: 'Negociação', probabilityBps: 8000 },
      ],
    },
  })
  const [qualify, propose, negotiate] = (await ok(`/crm/pipelines/${pipelineId}`)).stages.map((stage) => stage.id)
  const { entryId: sourceId } = await ok('/crm/sources', { method: 'POST', key: randomUUID(), body: { name: `Indicação ${run}` } })
  const { entryId: reasonId } = await ok('/crm/loss-reasons', { method: 'POST', key: randomUUID(), body: { name: `Prazo ${run}` } })
  const open = async (accountId, title) =>
    (
      await ok('/crm/opportunities', {
        method: 'POST',
        key: randomUUID(),
        body: {
          accountId,
          ownerId,
          pipelineId,
          stageId: qualify,
          sourceId,
          title,
          expectedValue: { amount: '1200000', currency: 'BRL' },
          expectedCloseOn: '2026-12-15',
        },
      })
    ).opportunityId
  const opportunityId = await open(foreignId, `Hooli ${run}`)
  const lostId = await open(undocumentedId, `Pied Piper ${run}`)
  for (const stageId of [propose, negotiate])
    await ok(`/crm/opportunities/${opportunityId}/stage`, { method: 'POST', body: { stageId } })
  await ok(`/crm/opportunities/${lostId}/lose`, { method: 'POST', body: { lossReasonId: reasonId, note: 'Sem orçamento' } })

  // --- a task whose reminder fires once ------------------------------------------------------
  const { taskId } = await ok('/crm/tasks', {
    method: 'POST',
    key: randomUUID(),
    body: {
      subject: { type: 'opportunity', id: opportunityId },
      assigneeId: ownerId,
      title: `Ligar para Gavin ${run}`,
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      remindAt: new Date(Date.now() - 1_000).toISOString(),
    },
  })
  await until('the reminder to be sent', async () => (await ok(`/crm/tasks/${taskId}`)).remindedAt)

  // --- convert into a quote: customer, Sales, quote v1, reassignment, v2, accepted ----------
  await ok(`/parties/parties/${foreignId}/roles/customer`, { method: 'PUT', body: { operation: 'grant' } })
  await until('Sales to list the foreign customer', async () =>
    (await ok('/sales/customers')).some((row) => row.id === foreignId),
  )
  const itemId = sql(
    'horizon_sales',
    `select item_id from catalog_items where tenant_id = '${tenantId}' and active = 1 and currency = 'BRL' and unit_price > 0 and coalesce(kind, 'product') = 'product' order by item_id limit 1`,
  )
  const lines = (quantity) => [{ lineId: randomUUID(), itemId, quantity }]
  const { quoteId: first } = await ok('/sales/quotes', {
    method: 'POST',
    key: randomUUID(),
    body: { customerId: foreignId, opportunityId, lines: lines('2') },
  })
  await ok(`/sales/quotes/${first}/send`, { method: 'POST' })
  await ok(`/crm/opportunities/${opportunityId}/owner`, { method: 'POST', body: { ownerId: nextOwnerId } })
  const { quoteId: second } = await ok(`/sales/quotes/${first}/revise`, {
    method: 'POST',
    key: randomUUID(),
    body: { lines: lines('3') },
  })
  await ok(`/sales/quotes/${second}/send`, { method: 'POST' })
  await ok(`/sales/quotes/${second}/accept`, { method: 'POST' })

  const attribution = { opportunityId, ownerId, sourceId }
  const quotes = [await ok(`/sales/quotes/${first}`), await ok(`/sales/quotes/${second}`)]
  assert.deepEqual(quotes.map((quote) => quote.attribution), [attribution, attribution])
  const won = await until('CRM to convert the opportunity', async () => {
    const detail = await ok(`/crm/opportunities/${opportunityId}`)
    return detail.status === 'won' ? detail : undefined
  })
  assert.deepEqual(won.conversion, { quoteId: second, quoteRoot: first, quoteVersion: 2 })
  assert.equal(won.sourceId, sourceId)
  assert.equal(won.expectedValue.amount, quotes[1].total)

  const events = await until('the facts on the bus', async () => {
    const found = await published()
    return found.some(({ type, payload }) => type === 'crm.opportunity.converted' && payload.opportunityId === opportunityId) &&
      found.some(({ type, payload }) => type === 'crm.task.due' && payload.taskId === taskId)
      ? found
      : undefined
  })
  const mine = events.filter(({ payload }) => [payload.opportunityId, payload.attribution?.opportunityId].includes(opportunityId))
  for (const { payload } of mine.filter(({ type }) => type.startsWith('sales.quote.')))
    assert.deepEqual(payload.attribution, attribution, 'every quote event carries the frozen attribution')
  const converted = mine.find(({ type }) => type === 'crm.opportunity.converted').payload
  assert.equal(converted.sourceId, sourceId)
  assert.equal(converted.value.amount, quotes[1].total)
  assert.equal(events.filter(({ type, payload }) => type === 'crm.task.due' && payload.taskId === taskId).length, 1)
  evidence.conversion = {
    foreignId,
    undocumentedId,
    opportunityId,
    quotes: { first, second, total: quotes[1].total },
    attribution,
    crmFacts: mine.filter(({ type }) => type.startsWith('crm.')).map(({ type }) => type.replace('crm.opportunity.', '')),
    reminder: 'sent once',
  }

  // --- the metrics are rebuilt from history and give the same numbers -----------------------
  const cutoff = new Date().toISOString()
  const numbers = async () => ({
    forecast: await ok(`/crm/forecast?groupBy=source&sourceId=${sourceId}&cutoff=${encodeURIComponent(cutoff)}`),
    metrics: await ok(`/crm/pipelines/${pipelineId}/metrics?cutoff=${encodeURIComponent(cutoff)}`),
  })
  const before = await numbers()
  assert.deepEqual(before.metrics.outcomes, { won: 1, lost: 1, winRateBps: 5000 })
  assert.deepEqual(before.metrics.lossReasons, [{ lossReasonId: reasonId, count: 1 }])
  const rebuild = JSON.parse(
    execFileSync('docker', ['exec', 'horizon-crm', 'npm', 'run', '--silent', 'rebuild:metrics', '--', '--tenant', tenantId], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .at(-1),
  )
  assert.equal(rebuild.drifted, 0)
  assert.equal(rebuild.numbersUnchanged, true)
  assert.deepEqual(await numbers(), before)
  evidence.metrics = {
    outcomes: before.metrics.outcomes,
    forecast: before.forecast.data,
    rebuild: { processed: rebuild.processed, drifted: rebuild.drifted, numbersUnchanged: rebuild.numbersUnchanged },
  }
} finally {
  await rabbit(`/queues/%2F/${probe}`, 'DELETE').catch(() => undefined)
}

console.log(JSON.stringify(evidence, null, 2))
