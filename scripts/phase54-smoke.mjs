#!/usr/bin/env node
/**
 * Phase 54 local-stack smoke through Kong (ADR 0057). A foreign company and a person with
 * no CPF become customers, reach Sales and receive a quote; a prospect is registered with
 * only its name and stays out of Sales; the duplicate check finds a lookalike; a repeated
 * foreign document is refused; a fiscal profile is refused without a CPF or CNPJ; and the
 * prospect is identified later, once. Party events are v2 and never carry the number.
 *
 *   node scripts/phase54-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
 *     [--postgres-container horizon-postgres]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
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
const postgresContainer = flag('postgres-container', 'horizon-postgres')

const operator = execFileSync(
  process.execPath,
  [
    join(root, 'infra/scripts/mint-dev-token.mjs'),
    '--tenant',
    tenantId,
    '--sub',
    randomUUID(),
    ...['parties:admin', 'sales:admin', 'catalog:admin'].flatMap((role) => ['--role', role]),
  ],
  { encoding: 'utf8' },
).trim()

async function call(path, { method = 'GET', body, key = method === 'GET' ? undefined : randomUUID() } = {}) {
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
  execFileSync(
    'docker',
    ['exec', postgresContainer, 'psql', '-U', 'postgres', '-d', database, '-At', '-c', statement],
    { encoding: 'utf8' },
  ).trim()

const reasonOf = (body) => body.detail ?? body.message
const run = Date.now().toString(36)
const evidence = { checkedAt: new Date().toISOString(), tenantId }

// --- a foreign company and a person without a CPF become customers ------------------------
const foreignNumber = `EIN-${randomInt(10_000_000, 99_999_999)}`
const foreign = await ok('/parties/parties', {
  method: 'POST',
  body: {
    kind: 'organization',
    legalName: `Northwind Traders ${run} Inc.`,
    document: { type: 'foreign', country: 'US', number: foreignNumber },
    email: `buyer-${run}@northwind.example`,
    phone: '+1 415 555 0100',
    address: '1 Market St, San Francisco, CA',
    roles: ['customer'],
  },
})
const undocumented = await ok('/parties/parties', {
  method: 'POST',
  body: {
    kind: 'person',
    legalName: `Maria Souza ${run}`,
    document: { type: 'none' },
    email: `maria-${run}@example.com`,
    phone: '+55 11 98888-7777',
    address: 'Rua das Palmeiras, 12, São Paulo',
    roles: ['customer'],
  },
})
const foreignRead = await ok(`/parties/parties/${foreign.partyId}`)
assert.deepEqual(foreignRead.document, {
  type: 'foreign',
  country: 'US',
  suffix: foreignNumber.slice(-4),
})
assert.equal((await ok(`/parties/parties/${undocumented.partyId}`)).document.type, 'none')

const repeated = await call('/parties/parties', {
  method: 'POST',
  body: {
    kind: 'organization',
    legalName: 'Northwind again',
    document: { type: 'foreign', country: 'us', number: foreignNumber.toLowerCase() },
    roles: ['prospect'],
  },
})
assert.equal(repeated.status, 409, JSON.stringify(repeated.body))
const refusedCustomer = await call('/parties/parties', {
  method: 'POST',
  body: { kind: 'person', legalName: 'Sem contato', document: { type: 'none' }, roles: ['customer'] },
})
assert.equal(refusedCustomer.status, 400, JSON.stringify(refusedCustomer.body))
evidence.customers = {
  foreign: foreign.partyId,
  undocumented: undocumented.partyId,
  repeatedForeignDocument: repeated.status,
  customerWithoutContacts: reasonOf(refusedCustomer.body),
}

// --- a prospect with only a name, found by the duplicate check ------------------------------
const prospect = await ok('/parties/parties', {
  method: 'POST',
  body: {
    kind: 'organization',
    legalName: `Acme Comércio ${run} Ltda.`,
    document: { type: 'none' },
    roles: ['prospect'],
  },
})
const lookalikes = await ok('/parties/parties/duplicate-check', {
  method: 'POST',
  body: { legalName: `ACME COMERCIO ${run.toUpperCase()}` },
})
assert.deepEqual(
  lookalikes.data.map((match) => [match.partyId, match.matchedOn]),
  [[prospect.partyId, ['name']]],
)
const byDocument = await ok('/parties/parties/duplicate-check', {
  method: 'POST',
  body: { legalName: 'Anyone', document: { type: 'foreign', country: 'US', number: foreignNumber } },
})
assert.deepEqual(byDocument.data[0]?.matchedOn, ['document'])
evidence.duplicates = { byName: lookalikes.data.length, byDocument: byDocument.data.length }

// --- party events are v2 and carry the type, never the number --------------------------------
const events = sql(
  'horizon_parties',
  `select event_version || ':' || (payload->>'documentType') || ':' || coalesce(payload->>'documentCountry', '-') || ':' || (payload::text like '%${foreignNumber}%')
     from outbox where tenant_id = '${tenantId}' and event_type = 'parties.party.registered'
     and payload->>'partyId' in ('${foreign.partyId}', '${undocumented.partyId}', '${prospect.partyId}')
     order by created_at`,
).split('\n')
assert.deepEqual(events, ['2:foreign:US:false', '2:none:-:false', '2:none:-:false'])
evidence.events = events

// --- both customers reach Sales and receive a quote; the prospect does not -------------------
const customers = await until('Sales to project both customers', async () => {
  const rows = await ok('/sales/customers')
  const ids = new Set(rows.map((row) => row.id))
  return ids.has(foreign.partyId) && ids.has(undocumented.partyId) ? rows : undefined
})
assert.ok(!customers.some((row) => row.id === prospect.partyId))
const profile = JSON.parse(
  execFileSync('docker', ['exec', 'horizon-fiscal', 'printenv', 'FISCAL_SIMULATION_PROFILE_JSON'], {
    encoding: 'utf8',
  }),
)
const goodId = Object.keys(profile.lineFacts)[0]
const quotes = []
for (const customerId of [foreign.partyId, undocumented.partyId]) {
  const quote = await ok('/sales/quotes', {
    method: 'POST',
    body: { customerId, lines: [{ lineId: randomUUID(), itemId: goodId, quantity: '1' }] },
  })
  const quoteId = quote.quoteId ?? quote.id
  await ok(`/sales/quotes/${quoteId}/send`, { method: 'POST' })
  quotes.push({ customerId, quoteId, status: (await ok(`/sales/quotes/${quoteId}`)).status })
}
assert.deepEqual(
  quotes.map((quote) => quote.status),
  ['sent', 'sent'],
)
evidence.quotes = quotes

// --- no Brazilian fiscal profile without a CPF or a CNPJ -------------------------------------
const fiscalProfile = {
  effectiveFrom: new Date().toISOString().slice(0, 10),
  stateRegistration: null,
  municipalRegistration: null,
  taxpayerIndicator: 'non-contributor',
  finalConsumer: true,
  address: {
    street: 'Market St',
    number: '1',
    complement: null,
    district: 'SoMa',
    city: 'San Francisco',
    municipalityCode: null,
    state: null,
    postalCode: '94105',
    country: 'US',
  },
}
const fiscalRefused = await call(`/parties/parties/${foreign.partyId}/fiscal-profile`, {
  method: 'PUT',
  body: fiscalProfile,
})
assert.equal(fiscalRefused.status, 409, JSON.stringify(fiscalRefused.body))
assert.match(reasonOf(fiscalRefused.body), /needs a CPF or CNPJ/)
evidence.fiscalProfileRefused = reasonOf(fiscalRefused.body)

// --- the prospect is identified once, and becomes a customer only once reachable -------------
const cnpj = `${randomInt(10_000_000, 99_999_999)}0001${randomInt(10, 99)}`
await ok(`/parties/parties/${prospect.partyId}/document`, {
  method: 'PUT',
  body: { document: { type: 'cnpj', number: cnpj } },
})
assert.equal((await ok(`/parties/parties/${prospect.partyId}`)).document.type, 'cnpj')
const again = await call(`/parties/parties/${prospect.partyId}/document`, {
  method: 'PUT',
  body: { document: { type: 'cnpj', number: cnpj } },
})
assert.equal(again.status, 409)
const grant = await call(`/parties/parties/${prospect.partyId}/roles/customer`, {
  method: 'PUT',
  body: { operation: 'grant' },
})
assert.equal(grant.status, 409, JSON.stringify(grant.body))
evidence.identify = { documentType: 'cnpj', secondIdentify: again.status, grantWithoutContacts: reasonOf(grant.body) }

console.log(JSON.stringify(evidence, null, 2))
