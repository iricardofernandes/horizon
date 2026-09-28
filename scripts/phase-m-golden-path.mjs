#!/usr/bin/env node
/**
 * Phase M golden path (Phase 70) on the local stack, through Kong. It closes the phase by
 * walking what production readiness promised, end to end, and writes the record to
 * docs/drills/<date>-phase-m-golden-path.json.
 *
 *   1. Load: a Parties import of 1,000 companies and 25 invalid rows, interrupted by
 *      `docker restart horizon-parties` while writing, ends with every row accounted for.
 *   2. Operate: a quote becomes an order, the order ships, and its receivable is settled into
 *      a treasury account.
 *   3. Report: the producers seal, the cash position at the settled cutoff shows the account,
 *      and its reconciliation with Financial and Treasury matches.
 *   4. Export: the same report as XLSX, ready, whose downloaded bytes match its digest.
 *   5. Drills: the records of the Phase 67, 68 and 69 drills exist and passed.
 *
 *   node scripts/phase-m-golden-path.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
 *     [--rows 1000] [--invalid 25]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const ROWS = Number(flag('rows', '1000'))
const INVALID = Number(flag('invalid', '25'))
const importTenant = randomUUID()

function token(tenant, roles) {
  return execFileSync(
    process.execPath,
    [join(root, 'infra/scripts/mint-dev-token.mjs'), '--tenant', tenant, '--sub', randomUUID(), ...roles.flatMap((role) => ['--role', role])],
    { encoding: 'utf8' },
  ).trim()
}
const operator = token(tenantId, [
  'parties:admin', 'sales:admin', 'financial:admin', 'treasury:admin', 'inventory:admin', 'catalog:admin', 'reporting:admin',
])
const importer = token(importTenant, ['parties:admin'])

async function call(path, { method = 'GET', body, bearer = operator, key = method === 'GET' ? undefined : randomUUID() } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  const type = response.headers.get('content-type') ?? ''
  return { status: response.status, headers: response.headers, bytes, body: type.includes('json') && bytes.length ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8') }
}

async function ok(path, options) {
  const result = await call(path, options)
  if (result.status >= 400) throw new Error(`${options?.method ?? 'GET'} ${path}: HTTP ${result.status} ${JSON.stringify(result.body)}`)
  return result.body
}

async function until(label, probe, timeoutMs = 180_000) {
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

const psql = (database, statement) =>
  execFileSync('docker', ['exec', 'horizon-postgres', 'psql', '-U', 'postgres', '-d', database, '-tAc', statement], { encoding: 'utf8' }).trim()

const record = { drill: 'phase-m-golden-path', phase: 70, startedAt: new Date().toISOString(), baseUrl, tenantId, passed: false, checks: [] }
function check(name, passed, evidence) {
  record.checks.push({ name, passed, evidence })
  console.log(`${passed ? '✓' : '✗'} ${name}`, JSON.stringify(evidence))
  assert.ok(passed, name)
}

function cnpj(seed) {
  const digits = String(30_000_000 + seed).padStart(8, '0').split('').map(Number).concat([0, 0, 0, 1])
  for (const weights of [[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]]) {
    const rest = digits.reduce((sum, value, index) => sum + value * weights[index], 0) % 11
    digits.push(rest < 2 ? 0 : 11 - rest)
  }
  return digits.join('')
}

// --- 1. load: an interrupted import that ends fully accounted -------------------------------
async function load() {
  const addsUp = ({ progress: { total, written, failed, remaining, cancelled } }) => total === written + failed + remaining + cancelled
  const lines = [
    'Tipo;Razão Social;CNPJ;E-mail;Telefone;Endereço;Papéis',
    ...Array.from({ length: ROWS }, (_, index) => `PJ;Cliente Fase M ${index} LTDA;${cnpj(index)};contato${index}@fase-m.example;1133330000;Rua ${index}, 10, São Paulo;cliente`),
    ...Array.from({ length: INVALID }, (_, index) => `PJ;Inválida ${index};${100 + index};x${index}@fase-m.example;1133330000;Rua B, 2, SP;cliente`),
  ]
  const file = { fileName: 'fase-m.csv', format: 'csv', locale: 'pt-BR', content: lines.join('\r\n') }
  const options = { bearer: importer }
  const uploaded = await ok('/parties/imports/parties', { ...options, method: 'POST', body: file })
  await ok(`/parties/imports/${uploaded.id}/mapping`, { ...options, method: 'PUT', body: { mapping: uploaded.mapping } })
  const preview = await ok(`/parties/imports/${uploaded.id}/preview`, { ...options, method: 'POST' })
  await ok(`/parties/imports/${uploaded.id}/confirm`, { ...options, method: 'POST' })
  const writing = await until('the import to be writing', async () => {
    const job = await ok(`/parties/imports/${uploaded.id}`, options)
    return job.progress.written > 20 && job.progress.remaining > 0 ? job : undefined
  }, 60_000)
  execFileSync('docker', ['restart', 'horizon-parties'])
  await until('Parties to be ready again', async () => (await call('/parties/health/ready')).status === 200)
  const done = await until('the import to finish', async () => {
    const job = await ok(`/parties/imports/${uploaded.id}`, options)
    return ['completed', 'completed-with-failures'].includes(job.status) ? job : undefined
  })
  const stored = Number(psql('horizon_parties', `select count(*) from parties where tenant_id = '${importTenant}'`))
  check('an import interrupted by a restart ends with every row accounted for',
    done.status === 'completed-with-failures' && addsUp(done) && done.progress.written === ROWS && done.progress.failed === INVALID && stored === ROWS,
    { jobId: uploaded.id, previewErrors: preview.errors.length, atRestart: writing.progress, final: done.progress, status: done.status, partiesStored: stored })
}

// --- 2. operate: sell, ship and settle into a treasury account ------------------------------
async function operate() {
  const today = new Date().toISOString().slice(0, 10)
  const accounts = (await ok(`/treasury/accounts?asOf=${today}`)).data
  const account = accounts.find((entry) => entry.name === 'Caixa Fase M') ?? (await ok('/treasury/accounts', {
    method: 'POST',
    body: { kind: 'cash', name: 'Caixa Fase M', currency: 'BRL', openedOn: today, openingBalance: { amount: '0', direction: 'inflow' } },
  }))
  const accountId = account.id ?? account.accountId
  const balanceOf = async () => (await ok(`/treasury/accounts?asOf=${today}`)).data.find((entry) => entry.id === accountId)?.bookBalance
  const before = await balanceOf()

  const [warehouse] = await ok('/inventory/warehouses')
  const itemId = warehouse.balances.find((balance) => Number(balance.onHand) >= 1)?.itemId
  assert.ok(itemId, 'the warehouse holds no stock to sell')
  const created = await ok('/parties/parties', {
    method: 'POST',
    body: { kind: 'organization', taxId: cnpj(900_000 + Math.floor(Math.random() * 90_000)), roles: ['customer'], legalName: 'Cliente Golden Path Fase M LTDA', email: `fase-m-${Date.now()}@example.com`, phone: '11999990000', address: 'Rua das Flores, 7, São Paulo' },
  })
  const customerId = created.id ?? created.partyId
  await until('Sales to know the customer', async () => (await ok('/sales/customers')).some((entry) => (entry.id ?? entry.partyId) === customerId))
  const quote = await ok('/sales/quotes', { method: 'POST', body: { customerId, lines: [{ lineId: randomUUID(), itemId, quantity: '1' }] } })
  const quoteId = quote.quoteId ?? quote.id
  await ok(`/sales/quotes/${quoteId}/send`, { method: 'POST' })
  await ok(`/sales/quotes/${quoteId}/accept`, { method: 'POST' })
  const converted = await ok(`/sales/quotes/${quoteId}/order`, { method: 'POST', body: { fulfillmentWarehouseId: warehouse.id } })
  const orderId = converted.orderId ?? converted.id
  await until('the order to be confirmed', async () => (await ok(`/sales/orders/${orderId}`)).status === 'confirmed')
  const orderLine = (await ok(`/sales/orders/${orderId}`)).requestedLines[0].lineId
  const picked = await ok('/sales/shipments', { method: 'POST', body: { orderId, lines: [{ lineId: orderLine, quantity: '1' }] } })
  const shipmentId = picked.shipmentId ?? picked.id
  await ok(`/sales/shipments/${shipmentId}/pack`, { method: 'POST', body: {} })
  await ok(`/sales/shipments/${shipmentId}/dispatch`, { method: 'POST', body: {} })

  const [title] = await until('the receivable', async () => {
    const titles = (await ok(`/financial/receivables?partyId=${customerId}&limit=10`)).data ?? []
    return titles.length ? titles : undefined
  })
  let detail = await ok(`/financial/receivables/${title.id}`)
  if (detail.status === 'draft') {
    // A title is classified before it is posted: under a revenue category of its own.
    const categories = (await ok('/financial/categories')).data
    const category = categories.find((entry) => entry.code === 'FASE-M-VENDAS') ?? (await ok('/financial/categories', {
      method: 'POST',
      body: { code: 'FASE-M-VENDAS', name: 'Vendas (golden path Fase M)', nature: 'revenue' },
    }))
    await ok(`/financial/receivables/${title.id}`, {
      method: 'PUT',
      body: {
        partyId: detail.partyId,
        documentNumber: detail.documentNumber,
        currency: detail.currency,
        categoryId: category.id,
        issuedOn: detail.issuedOn,
        competenceOn: detail.competenceOn,
        installments: detail.installments.map(({ dueOn, amount }) => ({ dueOn, amount })),
      },
    })
    await ok(`/financial/receivables/${title.id}/post`, { method: 'POST' })
    detail = await ok(`/financial/receivables/${title.id}`)
  }
  const installment = detail.installments[0]
  const settled = await ok(`/financial/receivables/${title.id}/settlements`, {
    method: 'POST',
    body: { installmentNumber: installment.number, settledOn: today, received: installment.outstanding, treasuryAccountId: accountId },
  })
  const after = await until('the settlement to reach the treasury account', async () => {
    const balance = await balanceOf()
    return BigInt(balance) - BigInt(before) === BigInt(installment.outstanding) ? balance : undefined
  })
  const closed = await ok(`/financial/receivables/${title.id}`)
  check('a sale ships and its receivable is settled into a treasury account',
    closed.settlementState === 'settled' && BigInt(after) - BigInt(before) === BigInt(installment.outstanding),
    { quoteId, orderId, shipmentId, receivableId: title.id, received: installment.outstanding, settlementId: settled.settlementId ?? settled.id ?? null, accountId, balanceBefore: before, balanceAfter: after, settlementState: closed.settlementState })
  return { accountId, received: installment.outstanding, balance: after, at: new Date().toISOString() }
}

// --- 3. report: the cash position at a settled cutoff, reconciled ---------------------------
function republish(module) {
  const output = execFileSync('docker', ['exec', `horizon-${module}`, 'npm', 'run', '--silent', 'republish:journal', '--', '--tenant', tenantId], { encoding: 'utf8' })
  return JSON.parse(output.trim().split('\n').at(-1))
}

async function report(operated) {
  const sources = ['financial', 'treasury']
  // A seal covers only what is older than its two-minute margin (ADR 0058), so the producers
  // are asked again until their seals reach past the settlement.
  let sealed = {}
  await until('seals past the settlement', async () => {
    sealed = Object.fromEntries(sources.map((module) => [module, republish(module)]))
    if (sources.some((module) => sealed[module].through < operated.at)) {
      await new Promise((resolve) => setTimeout(resolve, 15_000))
      return undefined
    }
    return true
  }, 300_000)
  await until('both seals to match', async () => {
    const { sources: states } = await ok('/reporting/sources')
    return sources.every((module) => {
      const state = states.find((candidate) => candidate.source === module)
      return state?.lastSeal?.through === sealed[module].through && state.lastSeal.outcome === 'matched'
    })
  })
  const cutoff = sources.map((module) => sealed[module].through).sort()[0]
  const answer = await ok(`/reporting/reports/cash-position?cutoff=${encodeURIComponent(cutoff)}`)
  const shown = answer.data.accounts.find((entry) => entry.accountId === operated.accountId)
  const run = await ok('/reporting/reports/cash-position/reconciliations', { method: 'POST', body: { cutoff } })
  check('the cash position at the settled cutoff shows the account and reconciles',
    answer.settled && shown?.balance === operated.balance && run.outcome === 'matched',
    { cutoff, seals: Object.fromEntries(sources.map((module) => [module, sealed[module].count])), settled: answer.settled, account: shown, runId: run.runId, outcome: run.outcome, checks: run.checks.map((entry) => `${entry.check}: ${entry.outcome}`) })
  return cutoff
}

// --- 4. export: XLSX, ready, bytes matching the digest --------------------------------------
async function exportFile(cutoff) {
  const job = await ok('/reporting/exports', { method: 'POST', body: { report: 'cash-position', cutoff, format: 'xlsx', locale: 'pt-BR' } })
  const jobId = job.jobId ?? job.id
  const ready = await until('the export to be ready', async () => {
    const found = await ok(`/reporting/exports/${jobId}`)
    if (found.status === 'failed') throw new Error(found.failure)
    return found.status === 'ready' ? found : undefined
  })
  const link = await ok(`/reporting/exports/${jobId}/link`)
  const file = await call(link.url, { bearer: operator })
  const digest = createHash('sha256').update(file.bytes).digest('hex')
  check('the report exports as XLSX whose bytes match its digest',
    file.status === 200 && digest === ready.sha256 && file.bytes.subarray(0, 2).toString() === 'PK' && ready.settled === true,
    { jobId, status: ready.status, settled: ready.settled, rows: ready.rows, bytes: file.bytes.length, sha256: ready.sha256, downloaded: digest, contentType: file.headers.get('content-type') })
}

// --- 5. the Phase M drills on record --------------------------------------------------------
function drills() {
  const directory = join(root, 'docs/drills')
  const found = Object.fromEntries(['phase67-security', 'phase68-controls', 'phase69-restore'].map((name) => {
    const file = existsSync(directory) ? readdirSync(directory).filter((entry) => entry.includes(name)).sort().at(-1) : undefined
    const drill = file ? JSON.parse(readFileSync(join(directory, file), 'utf8')) : null
    return [name, { file: file ?? null, passed: drill?.passed === true, checks: drill?.checks?.length ?? 0 }]
  }))
  check('the security, controls and restore drills are on record and passed', Object.values(found).every((entry) => entry.passed), found)
}

try {
  await load()
  const operated = await operate()
  const cutoff = await report(operated)
  await exportFile(cutoff)
  drills()
  record.passed = true
} finally {
  record.finishedAt = new Date().toISOString()
  const path = join(root, 'docs/drills', `${record.startedAt.slice(0, 10)}-phase-m-golden-path.json`)
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`${record.passed ? 'passed' : 'FAILED'} — ${path}`)
}
