#!/usr/bin/env node
/**
 * Phase 59 local-stack smoke: forecast and pipeline metrics through Kong, and the rebuild
 * command inside the CRM container.
 *
 * The first rebuild fills the metric rows of the opportunities that existed before the
 * migration (drift is expected there) and must leave nothing to repair. A new pipeline is
 * then worked through its stages; the forecast and the metrics are read at one cutoff;
 * a second rebuild finds no drift and leaves those numbers exactly as they were. A cutoff
 * from before the work shows none of it, and an old cutoff is reported as settled.
 *
 *   node scripts/phase59-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
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

const operator = execFileSync(
  process.execPath,
  [
    join(root, 'infra/scripts/mint-dev-token.mjs'),
    '--tenant',
    tenantId,
    '--sub',
    randomUUID(),
    ...['parties:admin', 'crm:manager'].flatMap((role) => ['--role', role]),
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

async function until(label, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined)
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

/** The rebuild command inside the running CRM container; its last line is the summary. */
function rebuild(...extra) {
  let output
  let failed = false
  try {
    output = execFileSync(
      'docker',
      ['exec', 'horizon-crm', 'npm', 'run', '--silent', 'rebuild:metrics', '--', '--tenant', tenantId, '--batch', '50', ...extra],
      { encoding: 'utf8' },
    )
  } catch (error) {
    failed = true
    output = error.stdout ?? ''
  }
  const lines = output.trim().split('\n').map((line) => JSON.parse(line))
  return { failed, batches: lines.filter((line) => line.step === 'batch').length, summary: lines.at(-1) }
}

const run = Date.now().toString(36)
const evidence = { checkedAt: new Date().toISOString(), tenantId }
const before = new Date(Date.now() - 1000).toISOString()

// --- the first rebuild fills the rows of opportunities older than the migration ------------
const first = rebuild()
assert.equal(first.failed, false, JSON.stringify(first.summary))
assert.equal(first.summary.residual, 0)
evidence.firstRebuild = {
  processed: first.summary.processed,
  drifted: first.summary.drifted,
  numbersUnchanged: first.summary.numbersUnchanged,
  batches: first.batches,
}

// --- a pipeline worked through its stages -------------------------------------------------
const owners = (await ok('/crm/owners')).data.filter((owner) => owner.active)
const [ownerId] = owners.map((owner) => owner.userId)
const { partyId: accountId } = await ok('/parties/parties', {
  method: 'POST',
  body: { kind: 'organization', legalName: `Soylent ${run} Ltda`, document: { type: 'none' }, roles: ['prospect'] },
})
await until('CRM to project the account', async () => (await call(`/crm/accounts/${accountId}`)).status === 200)
const { pipelineId } = await ok('/crm/pipelines', {
  method: 'POST',
  key: randomUUID(),
  body: {
    name: `Métricas ${run}`,
    stages: [
      { name: 'Qualificação', probabilityBps: 2000 },
      { name: 'Proposta', probabilityBps: 6000 },
    ],
  },
})
const [qualify, propose] = (await ok(`/crm/pipelines/${pipelineId}`)).stages.map((stage) => stage.id)
const { entryId: reason } = await ok('/crm/loss-reasons', { method: 'POST', key: randomUUID(), body: { name: `Orçamento ${run}` } })
const open = async (amount, closeOn) =>
  (
    await ok('/crm/opportunities', {
      method: 'POST',
      key: randomUUID(),
      body: {
        accountId,
        ownerId,
        pipelineId,
        stageId: qualify,
        title: `Soylent ${amount}`,
        expectedValue: { amount, currency: 'BRL' },
        expectedCloseOn: closeOn,
      },
    })
  ).opportunityId
const openOne = await open('400000', '2026-12-10')
const wonOne = await open('250000', '2026-11-20')
const lostOne = await open('90000', '2026-11-30')
for (const id of [openOne, wonOne])
  await ok(`/crm/opportunities/${id}/stage`, { method: 'POST', body: { stageId: propose } })
await ok(`/crm/opportunities/${wonOne}/win`, { method: 'POST' })
await ok(`/crm/opportunities/${lostOne}/lose`, { method: 'POST', body: { lossReasonId: reason } })

// --- the numbers at one cutoff ---------------------------------------------------------------
const cutoff = new Date().toISOString()
const read = async () => ({
  forecast: await ok(`/crm/forecast?groupBy=pipeline&pipelineId=${pipelineId}&cutoff=${encodeURIComponent(cutoff)}`),
  metrics: await ok(`/crm/pipelines/${pipelineId}/metrics?cutoff=${encodeURIComponent(cutoff)}`),
})
const live = await read()
const month = cutoff.slice(0, 7)
assert.deepEqual(
  live.forecast.data.map((row) => [row.month, row.openValue, row.weightedValue, row.wonValue]),
  [
    ['2026-12', '400000', '240000', '0'],
    [month, '0', '0', '250000'],
  ].sort((a, b) => a[0].localeCompare(b[0])),
)
assert.deepEqual(live.metrics.conversions, [{ fromStageId: qualify, toStageId: propose, count: 2 }])
assert.deepEqual(live.metrics.outcomes, { won: 1, lost: 1, winRateBps: 5000 })
assert.deepEqual(live.metrics.lossReasons, [{ lossReasonId: reason, count: 1 }])
assert.equal(live.metrics.settled, false)

// --- a second rebuild finds nothing to repair and changes nothing ---------------------------
const second = rebuild()
assert.equal(second.failed, false, JSON.stringify(second.summary))
assert.equal(second.summary.drifted, 0)
assert.equal(second.summary.numbersUnchanged, true)
assert.deepEqual(await read(), live)

// --- earlier cutoffs --------------------------------------------------------------------------
const earlier = await ok(`/crm/forecast?groupBy=pipeline&pipelineId=${pipelineId}&cutoff=${encodeURIComponent(before)}`)
assert.deepEqual(earlier.data, [])
const settled = await ok(`/crm/forecast?cutoff=${encodeURIComponent(new Date(Date.now() - 20 * 60_000).toISOString())}`)
assert.equal(settled.settled, true)
const future = await call(`/crm/forecast?cutoff=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)
assert.equal(future.status, 400)

evidence.pipeline = {
  pipelineId,
  cutoff,
  forecast: live.forecast.data,
  outcomes: live.metrics.outcomes,
  conversions: live.metrics.conversions,
}
evidence.secondRebuild = { processed: second.summary.processed, drifted: 0, numbersUnchanged: true }
console.log(JSON.stringify(evidence, null, 2))
