#!/usr/bin/env node
/**
 * Phase 57 local-stack smoke through Kong. On a fresh prospect account, a representative
 * records a call with a contact, writes and corrects a note on an opportunity, and gives
 * themselves a task with a reminder; assigning it to someone else is refused. The agenda
 * lists the task, both timelines merge the records with the opportunity history, and the
 * reminder reaches RabbitMQ once as `crm.task.due` — without the title — and is not sent
 * again after the CRM container restarts.
 *
 *   node scripts/phase57-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
const probe = `smoke.phase57.${Date.now()}`
await rabbit(`/queues/%2F/${probe}`, 'PUT', { durable: true, auto_delete: false })
await rabbit(`/bindings/%2F/e/horizon.events/q/${probe}`, 'POST', { routing_key: 'crm.task.#' })
const dueFor = async (taskId) => {
  const got = await rabbit(`/queues/%2F/${probe}/get`, 'POST', {
    count: 100,
    ackmode: 'ack_requeue_true',
    encoding: 'auto',
  })
  return got.filter((message) => JSON.parse(message.payload).payload.taskId === taskId)
}

const run = Date.now().toString(36)
const evidence = { checkedAt: new Date().toISOString(), tenantId }
try {
  // --- a representative who is a workspace user, an account, a contact, an opportunity ---
  const owners = (await ok('/crm/owners')).data.filter((owner) => owner.active)
  const [me, colleague] = owners.map((owner) => owner.userId)
  assert.ok(me && colleague, 'two active owners (phase 55 backfill)')
  const representative = token(me, 'crm:representative')

  const { partyId: accountId } = await ok('/parties/parties', {
    method: 'POST',
    body: { kind: 'organization', legalName: `Initech ${run} Ltda`, document: { type: 'none' }, roles: ['prospect'] },
  })
  await until('CRM to project the account', async () => (await call(`/crm/accounts/${accountId}`)).status === 200)
  const { contactId } = await ok(`/crm/accounts/${accountId}/contacts`, {
    method: 'POST',
    key: randomUUID(),
    body: { name: 'Peter Gibbons', lawfulBasis: 'legitimate-interest' },
  })
  const { pipelineId } = await ok('/crm/pipelines', {
    method: 'POST',
    key: randomUUID(),
    body: { name: `Vendas 57 ${run}`, stages: [{ name: 'Qualificação', probabilityBps: 1000 }, { name: 'Proposta', probabilityBps: 5000 }] },
  })
  const [qualification, proposal] = (await ok(`/crm/pipelines/${pipelineId}`)).stages.map((stage) => stage.id)
  const { opportunityId } = await ok('/crm/opportunities', {
    method: 'POST',
    key: randomUUID(),
    body: {
      accountId,
      ownerId: me,
      pipelineId,
      stageId: qualification,
      title: `Licenças Initech ${run}`,
      expectedValue: { amount: '900000', currency: 'BRL' },
      expectedCloseOn: '2026-12-20',
    },
  })

  // --- the records -------------------------------------------------------------------------
  const activityKey = randomUUID()
  const activity = {
    subject: { type: 'contact', id: contactId },
    kind: 'call',
    occurredAt: new Date(Date.now() - 15 * 60_000).toISOString(),
    title: 'Ligação com Peter',
    summary: 'Peter pediu uma demonstração.\nDecisão até o fim do mês.',
    contactIds: [contactId],
  }
  const { activityId } = await ok('/crm/activities', { method: 'POST', as: representative, key: activityKey, body: activity })
  assert.equal(
    (await ok('/crm/activities', { method: 'POST', as: representative, key: activityKey, body: activity })).activityId,
    activityId,
  )
  const future = await call('/crm/activities', {
    method: 'POST',
    as: representative,
    key: randomUUID(),
    body: { ...activity, occurredAt: new Date(Date.now() + 3_600_000).toISOString() },
  })
  assert.equal(future.status, 400)

  const { noteId } = await ok('/crm/notes', {
    method: 'POST',
    as: representative,
    key: randomUUID(),
    body: { subject: { type: 'opportunity', id: opportunityId }, body: 'Orçamento aprovado: R$ 10 mil' },
  })
  assert.equal(
    (await ok(`/crm/notes/${noteId}/revisions`, { method: 'POST', as: representative, body: { body: 'Orçamento aprovado: R$ 9 mil' } })).revision,
    2,
  )
  const note = await ok(`/crm/notes/${noteId}`)
  assert.deepEqual(
    note.revisions.map((revision) => revision.body),
    ['Orçamento aprovado: R$ 10 mil', 'Orçamento aprovado: R$ 9 mil'],
  )

  const remindAt = new Date(Date.now() + 5_000).toISOString()
  const dueAt = new Date(Date.now() + 60 * 60_000).toISOString()
  const toColleague = await call('/crm/tasks', {
    method: 'POST',
    as: representative,
    key: randomUUID(),
    body: { subject: { type: 'opportunity', id: opportunityId }, assigneeId: colleague, title: 'Não pode', dueAt },
  })
  assert.equal(toColleague.status, 403)
  const { taskId } = await ok('/crm/tasks', {
    method: 'POST',
    as: representative,
    key: randomUUID(),
    body: {
      subject: { type: 'opportunity', id: opportunityId },
      assigneeId: me,
      title: `Preparar demonstração para Peter ${run}`,
      dueAt,
      remindAt,
    },
  })
  const agenda = await ok('/crm/agenda', { as: representative })
  assert.ok(agenda.data.some((item) => item.id === taskId && item.overdue === false), 'the task is on my agenda')
  await ok(`/crm/opportunities/${opportunityId}/stage`, { method: 'POST', as: representative, body: { stageId: proposal } })
  evidence.records = { activityId, noteRevisions: note.revisions.length, taskId, agenda: agenda.page.total }

  // --- timelines -----------------------------------------------------------------------------
  const opportunityTimeline = await ok(`/crm/opportunities/${opportunityId}/timeline`)
  const accountTimeline = await ok(`/crm/accounts/${accountId}/timeline`)
  const kinds = (timeline) => timeline.data.map((entry) => entry.kind)
  assert.deepEqual(kinds(opportunityTimeline).sort(), ['note', 'opportunity-event', 'opportunity-event', 'task'])
  assert.deepEqual(kinds(accountTimeline).sort(), ['activity', 'note', 'opportunity-event', 'opportunity-event', 'task'])
  const instants = accountTimeline.data.map((entry) => Date.parse(entry.at))
  assert.deepEqual(instants, [...instants].sort((a, b) => b - a))
  assert.equal(accountTimeline.data.at(-1).kind, 'activity', 'the call happened before anything else')
  evidence.timelines = { opportunity: kinds(opportunityTimeline), account: kinds(accountTimeline) }

  // --- the reminder, once, then a restart ------------------------------------------------------
  const [due] = await until('the reminder to be sent', async () => {
    const found = await dueFor(taskId)
    return found.length ? found : undefined
  })
  const payload = JSON.parse(due.payload).payload
  assert.equal(payload.assigneeId, me)
  assert.deepEqual(payload.subject, { type: 'opportunity', id: opportunityId })
  assert.ok(!due.payload.includes('Peter') && !due.payload.includes('demonstração'), 'no title on the bus')
  assert.ok((await ok(`/crm/tasks/${taskId}`)).remindedAt, 'the task records the reminder')

  execFileSync('docker', ['restart', 'horizon-crm'], { stdio: 'ignore' })
  await until('CRM to come back', async () => (await call('/crm/health/ready')).status === 200)
  await sleep(35_000) // more than two scheduler intervals
  assert.equal((await dueFor(taskId)).length, 1, 'the reminder was sent once, restart included')

  await ok(`/crm/tasks/${taskId}/complete`, { method: 'POST', as: representative })
  assert.ok(!(await ok('/crm/agenda', { as: representative })).data.some((item) => item.id === taskId))
  evidence.reminder = { sent: 1, afterRestart: 1, remindAt }
} finally {
  await rabbit(`/queues/%2F/${probe}`, 'DELETE').catch(() => undefined)
}

console.log(JSON.stringify(evidence, null, 2))
