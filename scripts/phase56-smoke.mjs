#!/usr/bin/env node
/**
 * Phase 56 local-stack smoke through Kong. A manager sets up a pipeline, a source and a
 * loss reason; an opportunity is opened on an account, moved, reassigned, lost, reopened
 * and won; an archived stage keeps its opportunity and is refused as a destination; the
 * stored history rebuilds the record; and every fact reaches RabbitMQ as
 * `crm.opportunity.*`, without the title. A representative cannot change settings.
 *
 *   node scripts/phase56-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
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

const operator = token(randomUUID(), 'parties:admin', 'crm:manager', 'identity:owner')
const representative = token(randomUUID(), 'crm:representative')

async function call(path, { method = 'GET', body, as = operator, key } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${as}`,
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

// --- a probe queue on the event exchange, removed at the end -------------------------------
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
const probe = `smoke.phase56.${Date.now()}`
await rabbit(`/queues/%2F/${probe}`, 'PUT', { durable: true, auto_delete: false })
await rabbit(`/bindings/%2F/e/horizon.events/q/${probe}`, 'POST', { routing_key: 'crm.opportunity.#' })

const run = Date.now().toString(36)
const evidence = { checkedAt: new Date().toISOString(), tenantId }
try {
  // --- settings: a pipeline, a source and a loss reason ----------------------------------
  const refusedSettings = await call('/crm/pipelines', {
    method: 'POST',
    as: representative,
    key: randomUUID(),
    body: { name: 'Não', stages: [{ name: 'A', probabilityBps: 1 }] },
  })
  assert.equal(refusedSettings.status, 403)
  const { pipelineId } = await ok('/crm/pipelines', {
    method: 'POST',
    key: randomUUID(),
    body: {
      name: `Vendas ${run}`,
      stages: [
        { name: 'Qualificação', probabilityBps: 1000 },
        { name: 'Proposta', probabilityBps: 5000 },
        { name: 'Negociação', probabilityBps: 8000 },
      ],
    },
  })
  const { stageId: extraStage } = await ok(`/crm/pipelines/${pipelineId}/stages`, {
    method: 'POST',
    body: { name: 'Fechamento', probabilityBps: 9000 },
  })
  const pipeline = await ok(`/crm/pipelines/${pipelineId}`)
  const [qualification, proposal, negotiation] = pipeline.stages.map((stage) => stage.id)
  const { entryId: sourceId } = await ok('/crm/sources', { method: 'POST', key: randomUUID(), body: { name: `Indicação ${run}` } })
  const { entryId: reasonId } = await ok('/crm/loss-reasons', { method: 'POST', key: randomUUID(), body: { name: `Preço ${run}` } })
  const duplicateSource = await call('/crm/sources', { method: 'POST', key: randomUUID(), body: { name: `indicação ${run}` } })
  assert.equal(duplicateSource.status, 409)
  evidence.settings = { pipelineId, stages: pipeline.stages.length, sourceId, reasonId, duplicateSource: duplicateSource.status }

  // --- an account and an owner --------------------------------------------------------------
  const { partyId: accountId } = await ok('/parties/parties', {
    method: 'POST',
    body: { kind: 'organization', legalName: `Umbrella ${run} Ltda`, document: { type: 'none' }, roles: ['prospect'] },
  })
  await until('CRM to project the account', async () => (await call(`/crm/accounts/${accountId}`)).status === 200)
  const owners = await ok('/crm/owners')
  const [ownerId, otherOwnerId] = owners.data.filter((owner) => owner.active).map((owner) => owner.userId)
  assert.ok(ownerId && otherOwnerId, 'two active owners (phase 55 backfill)')
  await ok(`/crm/accounts/${accountId}`, { method: 'PATCH', body: { sourceId } })

  // --- the opportunity's life ---------------------------------------------------------------
  const key = randomUUID()
  const body = {
    accountId,
    ownerId,
    pipelineId,
    stageId: qualification,
    title: `Renovação Umbrella ${run}`,
    sourceId,
    expectedValue: { amount: '2500000', currency: 'BRL' },
    expectedCloseOn: '2026-12-15',
  }
  const { opportunityId } = await ok('/crm/opportunities', { method: 'POST', key, body })
  assert.equal((await ok('/crm/opportunities', { method: 'POST', key, body })).opportunityId, opportunityId)
  await ok(`/crm/opportunities/${opportunityId}/stage`, { method: 'POST', as: representative, body: { stageId: proposal } })
  const reassignByRep = await call(`/crm/opportunities/${opportunityId}/owner`, {
    method: 'POST',
    as: representative,
    body: { ownerId: otherOwnerId },
  })
  assert.equal(reassignByRep.status, 403)
  await ok(`/crm/opportunities/${opportunityId}/owner`, { method: 'POST', body: { ownerId: otherOwnerId } })
  const revision = {
    title: body.title,
    sourceId,
    expectedValue: { amount: '2800000', currency: 'BRL' },
    expectedCloseOn: body.expectedCloseOn,
  }
  assert.equal((await ok(`/crm/opportunities/${opportunityId}`, { method: 'PUT', body: revision })).revised, true)
  await ok(`/crm/opportunities/${opportunityId}/lose`, { method: 'POST', body: { lossReasonId: reasonId, note: 'Orçamento cortado' } })
  const moveWhileLost = await call(`/crm/opportunities/${opportunityId}/stage`, { method: 'POST', body: { stageId: negotiation } })
  assert.equal(moveWhileLost.status, 409)
  await ok(`/crm/opportunities/${opportunityId}/reopen`, { method: 'POST', body: { stageId: negotiation } })

  // --- an archived stage keeps its opportunity and is no destination ------------------------
  await ok(`/crm/pipelines/${pipelineId}/stages/${negotiation}`, { method: 'PATCH', body: { archived: true } })
  assert.equal((await ok(`/crm/opportunities/${opportunityId}`)).stageId, negotiation)
  const intoArchived = await call(`/crm/opportunities/${opportunityId}/stage`, { method: 'POST', body: { stageId: negotiation } })
  assert.equal(intoArchived.status, 409)
  await ok(`/crm/opportunities/${opportunityId}/stage`, { method: 'POST', body: { stageId: extraStage } })
  await ok(`/crm/opportunities/${opportunityId}/win`, { method: 'POST' })

  const detail = await ok(`/crm/opportunities/${opportunityId}`)
  assert.equal(detail.status, 'won')
  assert.deepEqual(
    detail.history.map((recorded) => recorded.fact.type),
    ['created', 'stage-changed', 'owner-changed', 'revised', 'lost', 'reopened', 'stage-changed', 'won'],
  )
  assert.equal(detail.history.filter((recorded) => recorded.fact.type === 'lost').length, 1)
  assert.equal((await ok(`/crm/opportunities?pipelineId=${pipelineId}&status=won`)).page.total, 1)
  evidence.opportunity = {
    opportunityId,
    history: detail.history.map((recorded) => recorded.fact.type),
    status: detail.status,
    value: detail.expectedValue,
  }

  // --- every fact reached RabbitMQ, without the title ---------------------------------------
  const messages = await until('the relay to publish the opportunity facts', async () => {
    const got = await rabbit(`/queues/%2F/${probe}/get`, 'POST', {
      count: 50,
      ackmode: 'ack_requeue_true',
      encoding: 'auto',
    })
    const mine = got.filter((message) => JSON.parse(message.payload).payload.opportunityId === opportunityId)
    return mine.length >= 8 ? mine : undefined
  })
  const types = messages.map((message) => message.routing_key.replace('crm.opportunity.', ''))
  assert.deepEqual(types, ['created', 'stage-changed', 'owner-changed', 'revised', 'lost', 'reopened', 'stage-changed', 'won'])
  assert.ok(!messages.some((message) => message.payload.includes('Renovação')), 'no title on the bus')
  const won = JSON.parse(messages.at(-1).payload)
  assert.deepEqual(won.payload.value, { amount: '2800000', currency: 'BRL' })
  assert.equal(won.payload.sourceId, sourceId)
  evidence.published = { types, wonValue: won.payload.value }
} finally {
  await rabbit(`/queues/%2F/${probe}`, 'DELETE').catch(() => undefined)
}

console.log(JSON.stringify(evidence, null, 2))
