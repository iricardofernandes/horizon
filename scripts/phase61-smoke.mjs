#!/usr/bin/env node
/**
 * Phase 61 local-stack smoke: the reporting journal through Kong, and `republish:journal`
 * inside the Sales and Financial containers (ADR 0058).
 *
 * A catalog item reaches the journal live. Sales and Financial resend their history and
 * seal it; both seals match and the watermarks move to their bounds. A second resend adds
 * nothing. A cutoff behind the watermarks is settled for those sources and one after them
 * is not. The journal refuses a rewrite, another tenant sees none of it, and a token with
 * no reporting role is refused.
 *
 *   node scripts/phase61-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
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

function token(tenant, roles) {
  return execFileSync(
    process.execPath,
    [
      join(root, 'infra/scripts/mint-dev-token.mjs'),
      '--tenant',
      tenant,
      '--sub',
      randomUUID(),
      ...roles.flatMap((role) => ['--role', role]),
    ],
    { encoding: 'utf8' },
  ).trim()
}

const operator = token(tenantId, ['catalog:admin', 'reporting:viewer'])

async function call(path, { method = 'GET', body, bearer = operator } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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

const sourcesAt = async (cutoff, bearer) =>
  ok(`/reporting/sources${cutoff ? `?cutoff=${encodeURIComponent(cutoff)}` : ''}`, { bearer })
const sourceOf = (answer, name) => answer.sources.find((source) => source.source === name)

/** The resend inside the producer's running container; its output is one JSON line. */
function republish(module) {
  const output = execFileSync(
    'docker',
    ['exec', `horizon-${module}`, 'npm', 'run', '--silent', 'republish:journal', '--', '--tenant', tenantId],
    { encoding: 'utf8' },
  )
  return JSON.parse(output.trim().split('\n').at(-1))
}

function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', 'horizon-postgres', 'psql', '-U', 'postgres', '-d', 'horizon_reporting', '-tAc', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
}

const evidence = { checkedAt: new Date().toISOString(), tenantId }

// --- a live event reaches the journal ------------------------------------------------------
const before = sourceOf(await sourcesAt(), 'catalog').events
const units = await ok('/catalog/units')
const unit = (units.data ?? units)[0]
await ok('/catalog/items', {
  method: 'POST',
  body: { kind: 'service', sku: `REP61-${Date.now()}`, name: 'Consultoria de relatórios', unitId: unit.id },
})
const live = await until('the catalog event to be journaled', async () => {
  const catalog = sourceOf(await sourcesAt(), 'catalog')
  return catalog.events > before ? catalog : undefined
})
evidence.live = { catalogEventsBefore: before, catalogEventsAfter: live.events }

// --- Sales and Financial resend their history and seal it ----------------------------------
const resent = {}
for (const module of ['sales', 'financial']) {
  const first = republish(module)
  const sealed = await until(`the ${module} seal to match`, async () => {
    const source = sourceOf(await sourcesAt(), module)
    return source.lastSeal?.through === first.through ? source : undefined
  })
  assert.equal(sealed.lastSeal.outcome, 'matched', JSON.stringify(sealed.lastSeal))
  assert.equal(sealed.lastSeal.journalCount, first.count)
  assert.equal(sealed.watermark, first.through)

  // A second resend keeps the first copy of every event: the journal does not grow.
  const heldBefore = sealed.events
  const second = republish(module)
  const again = await until(`the second ${module} seal`, async () => {
    const source = sourceOf(await sourcesAt(), module)
    return source.lastSeal?.through === second.through ? source : undefined
  })
  assert.equal(again.lastSeal.outcome, 'matched')
  assert.equal(again.events - heldBefore <= second.count - first.count, true)
  resent[module] = {
    sent: first.sent,
    count: first.count,
    through: first.through,
    secondSent: second.sent,
    eventsAfterFirst: heldBefore,
    eventsAfterSecond: again.events,
  }
}
evidence.resent = resent

// --- settlement follows the watermarks -----------------------------------------------------
const watermark = [resent.sales.through, resent.financial.through].sort()[0]
const behind = new Date(new Date(watermark).getTime() - 60_000).toISOString()
const atBehind = await sourcesAt(behind)
assert.equal(sourceOf(atBehind, 'sales').settled, true)
assert.equal(sourceOf(atBehind, 'financial').settled, true)
assert.equal(atBehind.settled, false, 'fiscal, crm and others were never sealed')
const atNow = await sourcesAt()
assert.equal(sourceOf(atNow, 'sales').settled, false)
evidence.settlement = {
  behind: { cutoff: behind, sales: true, financial: true, everySource: false },
  now: { sales: false },
}

// --- the journal is history, and it is the tenant's own ------------------------------------
for (const statement of ["update event_journal set arrival = 'replay'", 'delete from source_seals']) {
  let refused = ''
  try {
    psql(statement)
  } catch (error) {
    refused = String(error.stderr ?? error.message)
  }
  assert.match(refused, /append-only/)
}
const stranger = await sourcesAt(undefined, token(randomUUID(), ['reporting:admin']))
assert.equal(stranger.sources.every((source) => source.events === 0 && source.watermark === null), true)
const refused = await call('/reporting/sources', { bearer: token(tenantId, ['sales:admin']) })
assert.equal(refused.status, 403)
evidence.guards = { appendOnly: true, otherTenantSeesNothing: true, noRoleRefused: refused.status }

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
