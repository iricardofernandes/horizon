#!/usr/bin/env node
/**
 * Phase 66 local-stack smoke: federated search, notifications, saved views and the job
 * centre, in a fresh workspace, through Kong and the web server.
 *
 * Search finds a party, an item, a CRM account and a payable for someone who reads them,
 * shows a catalog-only user nothing else, and keeps answering with CRM stopped. A parties
 * import, a billing run, a quarantined file and a payable waiting for approval each
 * notify their person once, and a republished event notifies nobody again. A shared view
 * is seen by another user, who cannot delete it. The job centre lists the person's jobs.
 *
 *   node scripts/phase66-smoke.mjs [--base-url http://localhost:8000] [--web-url http://localhost:3000]
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
const baseUrl = flag('base-url', 'http://localhost:8000').replace(/\/$/, '')
const webUrl = flag('web-url', 'http://localhost:3000').replace(/\/$/, '')
const tenantId = randomUUID()
const marker = `S66${Date.now().toString(36).toUpperCase()}`

function token(roles, sub = randomUUID()) {
  return execFileSync(
    process.execPath,
    [join(root, 'infra/scripts/mint-dev-token.mjs'), '--tenant', tenantId, '--sub', sub, ...roles.flatMap((role) => ['--role', role])],
    { encoding: 'utf8' },
  ).trim()
}

const adminId = randomUUID()
const approverId = randomUUID()
const admin = token(
  ['parties:admin', 'catalog:admin', 'crm:admin', 'financial:admin', 'sales:admin', 'procurement:admin', 'reporting:admin'],
  adminId,
)
const approver = token(['financial:admin'], approverId)
const catalogOnly = token(['catalog:viewer'])

async function call(url, { method = 'GET', body, bearer = admin, key, raw, type, web = false } = {}) {
  const headers = {
    ...(web ? { cookie: `horizon_access=${bearer}` } : { authorization: `Bearer ${bearer}` }),
    ...(raw ? { 'content-type': type } : body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(key ? { 'idempotency-key': key } : {}),
  }
  const response = await fetch(url.startsWith('http') ? url : `${baseUrl}${url}`, {
    method,
    headers,
    ...(raw ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed }
}

async function ok(url, options) {
  const result = await call(url, options)
  if (result.status >= 400) throw new Error(`${options?.method ?? 'GET'} ${url}: HTTP ${result.status} ${JSON.stringify(result.body)}`)
  return result.body
}

async function until(label, probe, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined)
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function psql(database, sql) {
  return execFileSync('docker', ['exec', 'horizon-postgres', 'psql', '-U', 'postgres', '-d', database, '-tAc', sql], {
    encoding: 'utf8',
  }).trim()
}

function cnpj() {
  const base = Array.from({ length: 12 }, (_, index) => (index < 8 ? Math.floor(Math.random() * 10) : [0, 0, 0, 1][index - 8]))
  const digit = (digits) => {
    const weights = digits.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const rest = digits.reduce((sum, value, index) => sum + value * weights[index], 0) % 11
    return rest < 2 ? 0 : 11 - rest
  }
  const first = digit(base)
  return [...base, first, digit([...base, first])].join('')
}

const results = []
const record = (step, detail) => {
  results.push({ step, ...detail })
  console.log(`✓ ${step}`, JSON.stringify(detail))
}

const bell = (bearer) => ok('/reporting/notifications', { bearer })
const unread = async (bearer) => (await ok('/reporting/notifications/unread-count', { bearer })).unread
const kinds = async (bearer) => (await bell(bearer)).data.map((item) => item.kind).sort()

// --- Something to find ------------------------------------------------------------------
const party = await ok('/parties/parties', {
  method: 'POST',
  body: {
    kind: 'organization',
    taxId: cnpj(),
    roles: ['supplier', 'customer'],
    legalName: `Torrefação ${marker} LTDA`,
    email: `compras@${marker.toLowerCase()}.example`,
    phone: '1130000000',
    address: 'Rua da Busca, 66, São Paulo',
  },
})
const partyId = party.id ?? party.partyId
// A fresh workspace reaches Catalog through its import, which provisions the tenant there.
async function catalogImport(kind, content) {
  const job = await ok(`/catalog/imports/${kind}`, {
    method: 'POST',
    key: randomUUID(),
    body: { fileName: `${kind}.csv`, format: 'csv', locale: 'pt-BR', content },
  })
  await ok(`/catalog/imports/${job.id}/mapping`, { method: 'PUT', body: { mapping: job.mapping } })
  await ok(`/catalog/imports/${job.id}/preview`, { method: 'POST' })
  await ok(`/catalog/imports/${job.id}/confirm`, { method: 'POST' })
  await until(`catalog ${kind}`, async () => {
    const current = await ok(`/catalog/imports/${job.id}`)
    return current.status === 'completed' ? current : undefined
  })
}
await catalogImport('units', 'Código;Nome;Decimais\nUN;Unidade;0')
await catalogImport('items', `SKU;Nome;Unidade\n${marker}-1;Café ${marker};UN`)
await until('the party in CRM', async () =>
  (await ok(`/crm/accounts?search=${marker}`)).data.length > 0 ? true : undefined,
)

// --- A payable waiting for approval --------------------------------------------------------
await ok('/financial/payables/approval-policies', { method: 'PUT', body: { currency: 'BRL', threshold: '100000' } })
const today = new Date().toISOString().slice(0, 10)
const payable = await until('the supplier in Financial', async () => {
  const drafted = await call('/financial/payables', {
    method: 'POST',
    key: randomUUID(),
    body: { partyId, documentNumber: `NF-${marker}`, currency: 'BRL', issuedOn: today, installments: [{ dueOn: today, amount: '2500000' }] },
  })
  return drafted.status < 300 ? drafted.body : undefined
})
await ok(`/financial/payables/${payable.id}/approval-request`, { method: 'POST', body: {} })

// --- Search -------------------------------------------------------------------------------
const search = await until('search results', async () => {
  const answer = await ok(`${webUrl}/api/search?q=${marker}`, { web: true })
  return answer.results.length >= 4 ? answer : undefined
})
const found = [...new Set(search.results.map((result) => result.source))].sort()
assert.deepEqual(found, ['catalog.items', 'crm.accounts', 'financial.payables', 'parties.parties'])
assert.ok(search.sources.every((source) => source.status === 'ok'))
const narrow = await ok(`${webUrl}/api/search?q=${marker}`, { web: true, bearer: catalogOnly })
assert.deepEqual(narrow.sources.map((source) => source.source), ['catalog.items'])
assert.deepEqual([...new Set(narrow.results.map((result) => result.module))], ['catalog'])
record('search across modules, only what the roles read', { found, catalogOnly: narrow.results.length })

execFileSync('docker', ['stop', 'horizon-crm'])
let degraded
try {
  degraded = await ok(`${webUrl}/api/search?q=${marker}`, { web: true })
} finally {
  execFileSync('docker', ['start', 'horizon-crm'])
}
const crm = degraded.sources.find((source) => source.module === 'crm')
assert.notEqual(crm?.status, 'ok')
assert.ok(degraded.results.some((result) => result.module === 'parties'))
assert.ok(!degraded.results.some((result) => result.module === 'crm'))
record('search with CRM stopped', { crm: crm?.status, answered: [...new Set(degraded.results.map((result) => result.module))].sort() })

// --- Jobs that notify ---------------------------------------------------------------------
const imported = await ok('/parties/imports/parties', {
  method: 'POST',
  key: randomUUID(),
  body: { fileName: 'parceiros.csv', format: 'csv', locale: 'pt-BR', content: `Tipo;Razão Social;CNPJ\nPJ;Importada ${marker} LTDA;${cnpj()}` },
})
await ok(`/parties/imports/${imported.id}/mapping`, { method: 'PUT', body: { mapping: imported.mapping } })
await ok(`/parties/imports/${imported.id}/preview`, { method: 'POST' })
await ok(`/parties/imports/${imported.id}/confirm`, { method: 'POST' })
const competence = today.slice(0, 7)
await ok('/sales/billing-runs', { method: 'POST', key: randomUUID(), body: { competence } })
const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')
const slot = await ok('/files/attachments', {
  method: 'POST',
  key: randomUUID(),
  body: { module: 'parties', recordType: 'party', recordId: partyId, fileName: 'x.txt', contentType: 'text/plain', size: eicar.length },
})
await ok(slot.upload.url, { method: 'PUT', raw: eicar, type: 'text/plain' })

const adminKinds = await until('the admin notifications', async () => {
  const held = await kinds(admin)
  return ['billing-run-finished', 'file-quarantined', 'import-finished'].every((kind) => held.includes(kind)) ? held : undefined
})
assert.ok(!adminKinds.includes('approval-payable'), 'the requester is not asked to approve their own payable')
const approverKinds = await until('the approval notification', async () => {
  const held = await kinds(approver)
  return held.includes('approval-payable') ? held : undefined
})
assert.deepEqual(approverKinds, ['approval-payable'])
assert.deepEqual(await kinds(catalogOnly), [])
record('notifications for their people', { admin: adminKinds, approver: approverKinds, catalogOnly: 0 })

// --- Once, even when the event is published again -----------------------------------------
const importEvent = psql('horizon_parties', `select event_id from outbox where tenant_id = '${tenantId}' and event_type = 'parties.import.finished'`)
assert.match(importEvent, /^[0-9a-f-]{36}$/)
psql('horizon_parties', `update outbox set dispatched_at = null where event_id = '${importEvent}'`)
await until('the event republished', async () =>
  psql('horizon_parties', `select dispatched_at is not null from outbox where event_id = '${importEvent}'`) === 't' ? true : undefined,
)
await new Promise((resolve) => setTimeout(resolve, 3000))
const told = psql('horizon_reporting', `select count(*) from notifications where tenant_id = '${tenantId}' and source_id = '${importEvent}'`)
assert.equal(told, '1')
record('a republished event notifies nobody again', { notifications: Number(told) })

// --- Read state is per person -----------------------------------------------------------
const before = await unread(admin)
const first = (await bell(admin)).data[0]
await ok(`/reporting/notifications/${first.id}/read`, { method: 'POST' })
assert.equal(await unread(admin), before - 1)
await ok('/reporting/notifications/read-all', { method: 'POST' })
assert.equal(await unread(admin), 0)
assert.equal(await unread(approver), 1)
record('read per person', { before, afterOne: before - 1, afterAll: 0, approverStillUnread: 1 })

// --- Saved views ---------------------------------------------------------------------------
const view = await ok('/reporting/views', {
  method: 'POST',
  body: { screen: 'financial.payables', name: 'Aguardando aprovação', query: 'view=awaiting-approval', columns: ['counterparty', 'total'], shared: true },
})
const seen = await ok('/reporting/views?screen=financial.payables', { bearer: approver })
assert.deepEqual(seen.data.map((item) => [item.name, item.mine]), [['Aguardando aprovação', false]])
const refused = await call(`/reporting/views/${view.id}`, { method: 'DELETE', bearer: approver })
assert.equal(refused.status, 403)
const again = await call('/reporting/views', { method: 'POST', body: { screen: 'financial.payables', name: 'Aguardando aprovação', query: '' } })
assert.equal(again.status, 409)
const noRole = await call('/reporting/views?screen=catalog.items', { bearer: catalogOnly })
assert.equal(noRole.status, 200)
record('a shared view', { sharedWith: 'approver', othersDelete: refused.status, duplicate: again.status, withoutReportingRole: noRole.status })

// --- The job centre -------------------------------------------------------------------------
const jobs = await ok(`${webUrl}/api/jobs`, { web: true })
const sources = [...new Set(jobs.jobs.map((job) => job.source))].sort()
assert.ok(sources.includes('parties.imports'))
assert.ok(sources.includes('sales.billing-runs'))
assert.ok(jobs.jobs.every((job) => job.source !== 'parties.imports' || job.id === imported.id))
const page = await call(`${webUrl}/app/jobs`, { web: true })
assert.equal(page.status, 200)
record('the job centre', { sources, jobs: jobs.jobs.length, page: page.status })

console.log(JSON.stringify({ tenantId, steps: results.length }, null, 2))
