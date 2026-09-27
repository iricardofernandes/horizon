#!/usr/bin/env node
/**
 * Phase 62 local-stack smoke: cross-domain reports at a settled cutoff, reconciled against
 * the owners' own reports through Kong (ADR 0058).
 *
 * Every producer the reports read resends its history and seals it. At the settled cutoff,
 * the four reports are read and each is reconciled with the caller's own access: every
 * check must match. An opportunity won afterwards shows in the report at now and changes
 * nothing at the settled cutoff. A run at an unsettled cutoff is refused, a viewer cannot
 * reconcile, and saved filters are private unless an administrator shares them.
 *
 *   node scripts/phase62-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
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
const REPORTS = ['cash-position', 'order-to-cash', 'procure-to-pay', 'pipeline-to-revenue']
const PRODUCERS = ['sales', 'financial', 'treasury', 'inventory', 'procurement', 'ledger', 'crm']

function token(roles, sub = randomUUID()) {
  return execFileSync(
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
}

const OWNER_READS = ['financial:viewer', 'treasury:viewer', 'sales:viewer', 'procurement:viewer']
const analyst = token(['reporting:analyst', ...OWNER_READS, 'crm:manager', 'parties:admin'])
const administrator = token(['reporting:admin'])
const viewer = token(['reporting:viewer'])

async function call(path, { method = 'GET', body, bearer = analyst, key } = {}) {
  const started = performance.now()
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  const type = response.headers.get('content-type') ?? ''
  return {
    status: response.status,
    ms: Math.round(performance.now() - started),
    body: text && type.includes('json') ? JSON.parse(text) : text,
  }
}

async function ok(path, options) {
  const result = await call(path, options)
  if (result.status >= 400)
    throw new Error(`${options?.method ?? 'GET'} ${path}: HTTP ${result.status} ${JSON.stringify(result.body)}`)
  return result.body
}

async function until(label, probe, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined)
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function republish(module) {
  const output = execFileSync(
    'docker',
    ['exec', `horizon-${module}`, 'npm', 'run', '--silent', 'republish:journal', '--', '--tenant', tenantId],
    { encoding: 'utf8' },
  )
  return JSON.parse(output.trim().split('\n').at(-1))
}

const reportAt = (name, cutoff, query = '') =>
  call(`/reporting/reports/${name}?cutoff=${encodeURIComponent(cutoff)}${query}`)
const evidence = { checkedAt: new Date().toISOString(), tenantId }

// --- every producer resends its history and seals it ------------------------------------------
const sealed = Object.fromEntries(PRODUCERS.map((module) => [module, republish(module)]))
await until('every seal to match', async () => {
  const { sources } = await ok('/reporting/sources')
  return PRODUCERS.every((module) => {
    const source = sources.find((candidate) => candidate.source === module)
    return source?.lastSeal?.through === sealed[module].through && source.lastSeal.outcome === 'matched'
  })
})
const cutoff = PRODUCERS.map((module) => sealed[module].through).sort()[0]
evidence.seals = Object.fromEntries(PRODUCERS.map((module) => [module, sealed[module].count]))
evidence.cutoff = cutoff

// --- the four reports at the settled cutoff, each reconciled with the owners ------------------
const settledData = {}
evidence.reports = {}
for (const name of REPORTS) {
  const read = await reportAt(name, cutoff)
  assert.equal(read.status, 200, JSON.stringify(read.body))
  assert.equal(read.body.settled, true, `${name} settled at ${cutoff}`)
  settledData[name] = read.body.data
  const run = await ok(`/reporting/reports/${name}/reconciliations`, {
    method: 'POST',
    key: randomUUID(),
    body: { cutoff },
  })
  assert.equal(run.outcome, 'matched', `${name}: ${JSON.stringify(run.checks)}`)
  const again = await reportAt(name, cutoff)
  assert.equal(again.body.reconciliation?.runId, run.runId)
  evidence.reports[name] = {
    readMs: read.ms,
    checks: run.checks.map((check) => `${check.check}: ${check.outcome}`),
    derived: read.body.derived.map((figure) => figure.figure),
  }
}
evidence.figures = {
  cashPosition: settledData['cash-position'],
  orderToCash: settledData['order-to-cash'].currencies.map((row) => ({
    currency: row.currency,
    confirmed: row.confirmed,
    shipped: row.shipped,
    receivables: row.receivables,
  })),
  procureToPay: settledData['procure-to-pay'].currencies.map((row) => ({
    currency: row.currency,
    committed: row.committed,
    received: row.received,
    payables: row.payables,
  })),
}

// --- a late fact changes now, never the settled cutoff ----------------------------------------
const run = Date.now().toString(36)
const { partyId: accountId } = await ok('/parties/parties', {
  method: 'POST',
  body: { kind: 'organization', legalName: `Relatórios ${run} Ltda`, document: { type: 'none' }, roles: ['prospect'] },
})
await until('CRM to project the account', async () => (await call(`/crm/accounts/${accountId}`)).status === 200)
let owners = (await ok('/crm/owners')).data.filter((owner) => owner.active)
if (owners.length === 0) {
  // A workspace that predates CRM has its owners only after the one-off backfill (Phase 55).
  execFileSync(
    'docker',
    [
      'exec',
      '-e', 'IDENTITY_URL=http://identity:3001',
      '-e', `IDENTITY_TOKEN=${token(['identity:admin'])}`,
      'horizon-crm', 'npm', 'run', '--silent', 'backfill:owners', '--', '--tenant', tenantId,
    ],
    { encoding: 'utf8' },
  )
  owners = (await ok('/crm/owners')).data.filter((owner) => owner.active)
}
const { pipelineId } = await ok('/crm/pipelines', {
  method: 'POST',
  key: randomUUID(),
  body: { name: `Relatórios ${run}`, stages: [{ name: 'Proposta', probabilityBps: 5000 }] },
})
const [stageId] = (await ok(`/crm/pipelines/${pipelineId}`)).stages.map((stage) => stage.id)
const { opportunityId } = await ok('/crm/opportunities', {
  method: 'POST',
  key: randomUUID(),
  body: {
    accountId,
    ownerId: owners[0].userId,
    pipelineId,
    stageId,
    title: `Relatórios ${run}`,
    expectedValue: { amount: '123400', currency: 'BRL' },
    expectedCloseOn: '2026-12-31',
  },
})
await ok(`/crm/opportunities/${opportunityId}/win`, { method: 'POST' })
const month = new Date().toISOString().slice(0, 7)
const wonNow = (data) =>
  data.months
    .filter((row) => row.month === month && row.currency === 'BRL')
    .reduce((sum, row) => sum + row.won.count, 0)
const before = wonNow(settledData['pipeline-to-revenue'])
await until('the win to reach the journal', async () => {
  const now = await ok('/reporting/reports/pipeline-to-revenue')
  return wonNow(now.data) === before + 1
})
const stillSettled = await reportAt('pipeline-to-revenue', cutoff)
assert.deepEqual(stillSettled.body.data, settledData['pipeline-to-revenue'])
const unsettled = await call('/reporting/reports/pipeline-to-revenue/reconciliations', {
  method: 'POST',
  key: randomUUID(),
  body: {},
})
assert.equal(unsettled.status, 409, JSON.stringify(unsettled.body))
evidence.lateFact = { wonThisMonthAtCutoff: before, wonThisMonthNow: before + 1, settledUnchanged: true, unsettledRun: unsettled.status }

// --- roles and saved filters -----------------------------------------------------------------
const refused = await call('/reporting/reports/cash-position/reconciliations', {
  method: 'POST',
  key: randomUUID(),
  body: { cutoff },
  bearer: viewer,
})
assert.equal(refused.status, 403)
const mine = await ok('/reporting/saved-filters', {
  method: 'POST',
  key: randomUUID(),
  body: { report: 'order-to-cash', name: `Reais ${run}`, filter: { currency: 'BRL' } },
})
const notShared = await call('/reporting/saved-filters', {
  method: 'POST',
  key: randomUUID(),
  body: { report: 'order-to-cash', name: `Todos ${run}`, filter: {}, shared: true },
})
assert.equal(notShared.status, 400)
const shared = await ok('/reporting/saved-filters', {
  method: 'POST',
  key: randomUUID(),
  body: { report: 'cash-position', name: `Caixa ${run}`, filter: {}, shared: true },
  bearer: administrator,
})
const seenByViewer = (await ok('/reporting/saved-filters', { bearer: viewer })).data.map((filter) => filter.filterId)
assert.equal(seenByViewer.includes(shared.filterId), true)
assert.equal(seenByViewer.includes(mine.filterId), false)
const filtered = await ok(`/reporting/reports/order-to-cash?cutoff=${encodeURIComponent(cutoff)}&filterId=${mine.filterId}`)
assert.equal(filtered.data.currencies.every((row) => row.currency === 'BRL'), true)
await ok(`/reporting/saved-filters/${mine.filterId}`, { method: 'DELETE' })
await ok(`/reporting/saved-filters/${shared.filterId}`, { method: 'DELETE', bearer: administrator })
evidence.roles = { viewerReconcile: refused.status, analystShares: notShared.status, viewerSeesShared: true, viewerSeesPrivate: false }

// --- the dashboard at the settled cutoff -------------------------------------------------------
const dashboard = await call(`/reporting/dashboard?cutoff=${encodeURIComponent(cutoff)}`)
assert.equal(dashboard.status, 200)
assert.equal(Object.values(dashboard.body.reports).every((report) => report.settled), true)
evidence.dashboard = { readMs: dashboard.ms, settled: true }

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
