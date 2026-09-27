#!/usr/bin/env node
/**
 * Phase 63 local-stack smoke: reports exported as CSV and XLSX through Kong, their signed
 * links, a schedule that catches up, and list exports through the web server.
 *
 * At a settled cutoff every report is exported twice. The totals in each file equal the
 * report's own JSON at that cutoff. A link opens its file and nothing once changed. A
 * daily schedule made three days late runs once per missed day. A list exports as the
 * signed-in user: allowed with the role, refused without it, and a name that looks like a
 * formula comes out as text.
 *
 *   node scripts/phase63-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000] [--web-url http://localhost:3000]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const tenantId = flag('tenant', '01a0b6b8-c334-7136-8144-e48a7ba17e08')
const baseUrl = flag('base-url', 'http://localhost:8000').replace(/\/$/, '')
const webUrl = flag('web-url', 'http://localhost:3000').replace(/\/$/, '')
const REPORTS = ['cash-position', 'order-to-cash', 'procure-to-pay', 'pipeline-to-revenue']
const PRODUCERS = ['sales', 'financial', 'treasury', 'procurement', 'crm']

function token(roles, sub = randomUUID()) {
  return execFileSync(
    process.execPath,
    [join(root, 'infra/scripts/mint-dev-token.mjs'), '--tenant', tenantId, '--sub', sub, ...roles.flatMap((role) => ['--role', role])],
    { encoding: 'utf8' },
  ).trim()
}

const analyst = token(['reporting:analyst', 'crm:manager', 'parties:admin'])
const outsider = token(['reporting:viewer', 'sales:viewer'])

async function call(url, { method = 'GET', body, bearer = analyst, key, cookie } = {}) {
  const response = await fetch(url.startsWith('http') ? url : `${baseUrl}${url}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : { authorization: `Bearer ${bearer}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  })
  const type = response.headers.get('content-type') ?? ''
  const bytes = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    body: type.includes('json') ? JSON.parse(bytes.toString('utf8') || 'null') : bytes.toString('utf8'),
  }
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
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

/** The table of a CSV export, after its metadata rows and the blank row. */
function csvTable(text, separator) {
  const lines = text.replace(/^﻿/, '').trim().split('\r\n')
  const blank = lines.indexOf('')
  const metadata = Object.fromEntries(lines.slice(0, blank).map((line) => line.split(separator)))
  const split = (line) => line.match(new RegExp(`("(?:[^"]|"")*"|[^${separator}]*)(${separator}|$)`, 'g')).slice(0, -1).map((cell) => cell.replace(new RegExp(`${separator}$`), '').replace(/^"|"$/g, '').replaceAll('""', '"'))
  const [header, ...rows] = lines.slice(blank + 1)
  const columns = split(header)
  return { metadata, rows: rows.map((row) => Object.fromEntries(split(row).map((cell, index) => [columns[index], cell]))) }
}

/** Decimal text in the file's locale, as a number. */
const number = (text, locale) => Number(locale === 'pt-BR' ? text.replace(',', '.') : text)
const money = (minor) => Number(minor) / 100

/** What each file must hold, read from the report's own JSON. */
function expected(name, data) {
  switch (name) {
    case 'cash-position':
      return [
        ...data.receivables.map((row) => [`receivables:${row.currency}`, 'amount', money(row.outstanding)]),
        ...data.payables.map((row) => [`payables:${row.currency}`, 'amount', money(row.outstanding)]),
        ...data.accounts.map((row) => [`account:${row.accountId}`, 'amount', money(row.balance)]),
      ]
    case 'order-to-cash':
      return data.currencies.flatMap((row) => [
        [row.currency, 'confirmed_total', money(row.confirmed.total)],
        [row.currency, 'shipped', money(row.shipped)],
        [row.currency, 'receivables_raised', money(row.receivables.raised)],
      ])
    case 'procure-to-pay':
      return data.currencies.flatMap((row) => [
        [row.currency, 'committed_total', money(row.committed.total)],
        [row.currency, 'received', money(row.received)],
      ])
    default:
      return data.months.map((row) => [`month:${row.month}:${row.currency}`, 'won_value', money(row.won.value)])
  }
}

function keyOf(name, row) {
  if (name === 'cash-position') return `${row.section}:${row.key}`
  if (name === 'pipeline-to-revenue') return `${row.section}:${row.month}:${row.currency}`
  return row.currency
}

async function exported(name, cutoff, format, locale) {
  const job = await ok('/reporting/exports', {
    method: 'POST',
    key: randomUUID(),
    body: { report: name, cutoff, format, locale },
  })
  const ready = await until(`${name} ${format} to be written`, async () => {
    const current = await ok(`/reporting/exports/${job.jobId}`)
    return current.status === 'ready' ? current : undefined
  })
  const link = await ok(`/reporting/exports/${job.jobId}/link`)
  const file = await call(link.url)
  assert.equal(file.status, 200)
  return { job: ready, link, file }
}

const evidence = { checkedAt: new Date().toISOString(), tenantId }

// --- a settled cutoff --------------------------------------------------------------------------
const sealed = PRODUCERS.map((module) =>
  JSON.parse(
    execFileSync('docker', ['exec', `horizon-${module}`, 'npm', 'run', '--silent', 'republish:journal', '--', '--tenant', tenantId, '--seal-only'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .at(-1),
  ),
)
const cutoff = sealed.map((seal) => seal.through).sort()[0]
await until('the seals to match', async () => {
  const { sources } = await ok('/reporting/sources')
  return PRODUCERS.every((module) => sources.find((source) => source.source === module)?.watermark >= cutoff)
})
evidence.cutoff = cutoff

// --- every report as CSV and XLSX, equal to its JSON -------------------------------------------
evidence.reports = {}
const scratch = mkdtempSync(join(tmpdir(), 'phase63-'))
for (const name of REPORTS) {
  const report = await ok(`/reporting/reports/${name}?cutoff=${encodeURIComponent(cutoff)}`)
  assert.equal(report.settled, true)
  const csv = await exported(name, cutoff, 'csv', 'pt-BR')
  const table = csvTable(csv.file.bytes.toString('utf8'), ';')
  assert.equal(table.metadata.report, name)
  assert.equal(table.metadata.cutoff, cutoff)
  assert.equal(table.metadata.settled, 'true')
  const checks = expected(name, report.data)
  for (const [key, column, value] of checks) {
    const row = table.rows.find((candidate) => keyOf(name, candidate) === key)
    assert.ok(row, `${name}: no row ${key}`)
    assert.equal(number(row[column], 'pt-BR'), value, `${name} ${key} ${column}`)
  }
  const xlsx = await exported(name, cutoff, 'xlsx', 'en')
  assert.equal(xlsx.file.bytes.subarray(0, 2).toString(), 'PK')
  const path = join(scratch, `${name}.xlsx`)
  writeFileSync(path, xlsx.file.bytes)
  const sheet = execFileSync('unzip', ['-p', path, 'xl/worksheets/sheet1.xml'], { encoding: 'utf8' })
  for (const [, , value] of checks) assert.ok(sheet.includes(`<v>${value}</v>`) || value === 0, `${name} xlsx holds ${value}`)
  assert.equal(
    xlsx.file.headers.get('digest'),
    `sha-256=${Buffer.from(xlsx.job.sha256, 'hex').toString('base64')}`,
  )
  evidence.reports[name] = { rows: csv.job.rows, csvBytes: csv.job.bytes, xlsxBytes: xlsx.job.bytes, checked: checks.length }
}

// --- the link opens one file, and nothing once changed -----------------------------------------
const { link } = await exported('cash-position', cutoff, 'csv', 'en')
const url = new URL(link.url, baseUrl)
const tampered = new URL(url)
tampered.searchParams.set('signature', `${url.searchParams.get('signature').slice(0, -1)}0`)
const stretched = new URL(url)
stretched.searchParams.set('expires', String(Number(url.searchParams.get('expires')) + 3_600_000))
const otherTenant = new URL(url)
otherTenant.searchParams.set('tenant', randomUUID())
const refusals = await Promise.all([tampered, stretched, otherTenant].map(async (candidate) => (await call(candidate.toString())).status))
assert.deepEqual(refusals, [403, 403, 403])
assert.equal((await call(url.toString())).status, 200)
evidence.links = { valid: 200, tampered: refusals[0], stretched: refusals[1], otherTenant: refusals[2] }

// --- a schedule made three days late catches up once per day -----------------------------------
const since = new Date(Date.now() - 3 * 86_400_000).toISOString()
const schedule = await ok('/reporting/export-schedules', {
  method: 'POST',
  key: randomUUID(),
  body: { report: 'order-to-cash', format: 'csv', locale: 'pt-BR', cadence: 'daily', timeZone: 'UTC', since },
})
const runs = await until('the missed runs', async () => {
  const { data } = await ok('/reporting/exports?limit=100')
  const mine = data.filter((job) => job.scheduleId === schedule.scheduleId)
  return mine.length === 3 && mine.every((job) => job.status === 'ready') ? mine : undefined
})
const cutoffs = runs.map((job) => job.cutoff).sort()
assert.deepEqual(cutoffs.map((instant) => instant.slice(11)), ['00:00:00.000Z', '00:00:00.000Z', '00:00:00.000Z'])
await ok(`/reporting/export-schedules/${schedule.scheduleId}`, { method: 'DELETE' })
evidence.schedule = { cadence: 'daily', cutoffs, runs: runs.length }

// --- lists through the web server, as the user -------------------------------------------------
const run = Date.now().toString(36)
const { partyId } = await ok('/parties/parties', {
  method: 'POST',
  body: { kind: 'organization', legalName: `=HYPERLINK("http://x") ${run}`, document: { type: 'none' }, roles: ['prospect'] },
})
await until('CRM to project the account', async () => (await call(`/crm/accounts/${partyId}`)).status === 200)
const list = await call(`${webUrl}/api/export/crm/accounts?role=prospect&locale=pt-BR`, { cookie: `horizon_access=${analyst}` })
assert.equal(list.status, 200, list.body)
assert.match(list.headers.get('content-disposition'), /crm-accounts-.*\.csv/)
const accounts = csvTable(list.body, ';')
assert.equal(accounts.metadata.filter, 'role=prospect')
const formula = accounts.rows.find((row) => row.id === partyId)
assert.ok(formula, 'the new prospect is in the export')
assert.equal(formula.legalName.startsWith("'="), true, formula.legalName)
const refusedList = await call(`${webUrl}/api/export/crm/accounts?locale=en`, { cookie: `horizon_access=${outsider}` })
assert.equal(refusedList.status, 403)
evidence.lists = { rows: accounts.rows.length, formulaCell: formula.legalName.slice(0, 12), withoutRole: refusedList.status }

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
