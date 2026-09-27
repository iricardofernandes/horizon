#!/usr/bin/env node
/**
 * Phase 52 local-stack smoke through Kong. Two monthly contracts from last month are
 * billed by runs of this month and last month: one bills, the other is refused because
 * its service was deactivated in the Catalog. A run repeated under its key finds the same
 * run, and a new run bills nothing twice. Each billed period raises one receivable in
 * Financial and one NFS-e in Fiscal (issued at once under the `automatic` policy); the
 * billed fact replayed under a new event id changes nothing; a billed month refuses an
 * amendment; and a credit withdraws the receivable and cancels the NFS-e with event
 * 101101, keeping the period.
 *
 *   node scripts/phase52-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
 *     [--postgres-container horizon-postgres]
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
const postgresContainer = flag('postgres-container', 'horizon-postgres')

const operator = execFileSync(
  process.execPath,
  [
    join(root, 'infra/scripts/mint-dev-token.mjs'),
    '--tenant',
    tenantId,
    '--sub',
    randomUUID(),
    ...['parties:admin', 'sales:admin', 'catalog:admin', 'fiscal:admin'].flatMap((role) => ['--role', role]),
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
    signal: AbortSignal.timeout(60_000),
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

async function until(label, probe, timeoutMs = 120_000) {
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

function checkDigits(base, weightsFor) {
  const digits = [...base]
  for (const weights of weightsFor) {
    const rest = digits.reduce((sum, value, index) => sum + value * weights[index], 0) % 11
    digits.push(rest < 2 ? 0 : 11 - rest)
  }
  return digits.join('')
}
const cnpj = () =>
  checkDigits(
    [...Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)), 0, 0, 0, 1],
    [
      [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
      [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
    ],
  )

/** The first day of the month `months` from the current UTC month. */
const month = (months) => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1)).toISOString().slice(0, 10)
}
const thisMonth = month(0).slice(0, 7)
const lastMonth = month(-1).slice(0, 7)
const evidence = { checkedAt: new Date().toISOString(), tenantId, months: [lastMonth, thisMonth] }
const establishmentId = tenantId

// --- two priced Catalog services with their fiscal profile ---------------------------------
const [unit] = (await ok('/catalog/units')).data
const priceLists = (await ok('/catalog/price-lists')).data ?? (await ok('/catalog/price-lists'))
const priceList = priceLists.find((row) => row.currency === 'BRL')
async function pricedService(name, amount) {
  const item = await ok('/catalog/items', {
    method: 'POST',
    body: { kind: 'service', sku: `CTR52-${Date.now()}-${amount}`, name, unitId: unit.id },
  })
  const itemId = item.id ?? item.itemId
  await ok(`/catalog/price-lists/${priceList.id}/prices/${itemId}`, {
    method: 'PUT',
    body: { amount, currency: 'BRL' },
  })
  await until(`Sales to project ${name} with its price`, async () =>
    sql('horizon_sales', `select kind from catalog_items where tenant_id = '${tenantId}' and item_id = '${itemId}' and unit_price is not null`) === 'service',
  )
  await until(`the fiscal profile of ${name}`, async () => {
    const saved = await call('/fiscal/service-profiles', {
      method: 'POST',
      body: {
        itemId,
        nationalTaxCode: '010101',
        nbsCode: '115022000',
        issTaxation: '1',
        description: name,
        effectiveFrom: '2026-01-01',
        reason: 'Classificação revisada no smoke da fase 52',
      },
    })
    if (saved.status >= 400) throw new Error(JSON.stringify(saved.body))
    return saved.body
  })
  return itemId
}
const supportId = await pricedService('Suporte técnico mensal', '45000')
const retiredId = await pricedService('Monitoramento legado', '30000')

// --- a customer with a national fiscal profile ---------------------------------------------
const party = await ok('/parties/parties', {
  method: 'POST',
  body: {
    kind: 'organization',
    taxId: cnpj(),
    roles: ['customer'],
    legalName: 'Cliente Recorrente Smoke Fase 52 LTDA',
    email: `contratos52-${Date.now()}@example.com`,
    phone: '11999990000',
    address: 'Avenida Paulista, 1000, São Paulo',
  },
})
const customerId = party.id ?? party.partyId
await ok(`/parties/parties/${customerId}/fiscal-profile`, {
  method: 'PUT',
  body: {
    effectiveFrom: '2026-01-01',
    stateRegistration: null,
    municipalRegistration: null,
    taxpayerIndicator: 'non-contributor',
    finalConsumer: false,
    address: {
      street: 'Avenida Paulista',
      number: '1000',
      complement: 'Conjunto 101',
      district: 'Bela Vista',
      city: 'São Paulo',
      municipalityCode: '3550308',
      state: 'SP',
      postalCode: '01310100',
      country: 'BR',
    },
  },
})
await until('Sales to project the customer', async () =>
  (await ok('/sales/customers')).some((row) => (row.id ?? row.partyId) === customerId),
)

await ok(`/fiscal/service-issuance-policies/${establishmentId}`, {
  method: 'PUT',
  body: { mode: 'automatic', series: 52, reason: 'Emissão automática para o smoke da fase 52' },
})

// --- two monthly contracts from last month, billed on the 1st -------------------------------
async function contract(itemId) {
  const { contractId } = await ok('/sales/contracts', {
    method: 'POST',
    body: {
      customerId,
      lines: [{ lineId: randomUUID(), itemId, quantity: '2' }],
      recurrence: 'monthly',
      startsOn: month(-1),
      billingDay: 1,
      paymentTermDays: [10],
      notes: 'Contrato do smoke da fase 52',
    },
  })
  await ok(`/sales/contracts/${contractId}/activate`, { method: 'POST' })
  return contractId
}
const billedId = await contract(supportId)
const refusedId = await contract(retiredId)
evidence.contracts = { billed: billedId, refused: refusedId }

// The second contract's service leaves the Catalog: runs refuse it until a person acts.
await ok(`/catalog/items/${retiredId}/deactivate`, { method: 'PATCH' })
await until('Sales to project the deactivation', async () =>
  sql('horizon_sales', `select active from catalog_items where tenant_id = '${tenantId}' and item_id = '${retiredId}'`) === '0',
)

// --- preview, then runs repeated under the same key and under a new one --------------------
const mine = (items) =>
  Object.fromEntries(
    items
      .filter((item) => item.contractId === billedId || item.contractId === refusedId)
      .map((item) => [item.contractId === billedId ? 'billed' : 'refused', [item.outcome, item.reason]]),
  )
const preview = await ok('/sales/billing-runs/preview', { method: 'POST', body: { competence: thisMonth } })
assert.deepEqual(mine(preview.items), {
  billed: ['billed', null],
  refused: ['refused', 'service-unavailable'],
})
const runKey = randomUUID()
const run = await ok('/sales/billing-runs', { method: 'POST', body: { competence: thisMonth }, key: runKey })
assert.equal(run.status, 'completed')
assert.deepEqual(mine(run.items), { billed: ['billed', null], refused: ['refused', 'service-unavailable'] })
const repeated = await ok('/sales/billing-runs', { method: 'POST', body: { competence: thisMonth }, key: runKey })
assert.equal(repeated.id, run.id)
const rerun = await ok('/sales/billing-runs', { method: 'POST', body: { competence: thisMonth } })
assert.notEqual(rerun.id, run.id)
assert.deepEqual(mine(rerun.items), {
  billed: ['skipped', 'already-billed'],
  refused: ['refused', 'service-unavailable'],
})
const earlier = await ok('/sales/billing-runs', { method: 'POST', body: { competence: lastMonth } })
assert.deepEqual(mine(earlier.items), { billed: ['billed', null], refused: ['refused', 'service-unavailable'] })
const future = await call('/sales/billing-runs', { method: 'POST', body: { competence: month(1).slice(0, 7) } })
assert.equal(future.status, 409, JSON.stringify(future.body))
evidence.runs = {
  [thisMonth]: { run: run.id, repeatedUnderKey: repeated.id, rerun: rerun.id, totals: run.totals },
  [lastMonth]: { run: earlier.id, totals: earlier.totals },
}

// --- one receivable and one NFS-e per billed period -----------------------------------------
const billed = async () => (await ok(`/sales/contracts/${billedId}/billed-periods`)).periods
const periods = await billed()
assert.deepEqual(periods.map((period) => period.competence), [lastMonth, thisMonth])
assert.ok(periods.every((period) => period.value === '90000' && period.revision === 1))
assert.equal((await ok(`/sales/contracts/${refusedId}/billed-periods`)).periods.length, 0)
const titlesOf = (billedPeriodId) =>
  sql('horizon_financial', `select count(*) || ':' || coalesce(string_agg(status || '/' || document_number, ','), '') from titles where tenant_id = '${tenantId}' and origin_type = 'sales-contract-period' and origin_document_id = '${billedPeriodId}'`)
for (const period of periods)
  await until(`the receivable of ${period.competence}`, async () =>
    titlesOf(period.id) === `1:draft/CT-${period.id.slice(-8).toUpperCase()}`,
  )
const intakesOf = async (period) =>
  (await ok(`/fiscal/service-intakes?documentType=contract-period&period=${period.competence}`)).data.filter(
    (intake) => intake.billedPeriodId === period.id,
  )
const documents = {}
for (const period of periods) {
  const [intake] = await until(`the NFS-e of ${period.competence}`, async () => {
    const found = await intakesOf(period)
    if (found[0]?.status === 'blocked') throw new Error(found[0].reason)
    return found[0]?.status === 'issuing' ? found : undefined
  })
  const document = await until('NFS-e generation', async () => {
    const read = await ok(`/fiscal/service-documents/${intake.documentId}`)
    if (read.status === 'rejected') throw new Error(`NFS-e rejected: ${intake.documentId}`)
    return read.status === 'authorized' ? read : undefined
  })
  assert.equal(document.series, 52)
  assert.deepEqual(intake.sourceKey, {
    module: 'sales',
    documentType: 'contract-period',
    id: period.lines[0].entryId,
    period: period.competence,
  })
  assert.equal(intake.competenceDate, `${period.competence}-01`)
  documents[period.competence] = { documentId: document.id, nfseNumber: document.nfseNumber }
}
// Sales follows the NFS-e of each billed line.
await until('Sales to follow the NFS-e', async () =>
  (await billed()).every((period) => period.lines.every((line) => line.nfse.status === 'authorized')),
)
evidence.effects = { titles: periods.map((period) => titlesOf(period.id)), documents }

// --- the billed fact replayed under a new event id changes nothing ---------------------------
const current = periods[1]
const replayId = randomUUID()
sql(
  'horizon_sales',
  `begin; select set_config('app.current_tenant', '${tenantId}', true);
   insert into outbox (id, tenant_id, event_id, event_type, event_version, occurred_at, trace_id, payload)
   select '${replayId}', tenant_id, '${replayId}', event_type, event_version, now(), trace_id, payload
   from outbox where tenant_id = '${tenantId}' and event_type = 'sales.contract-period.billed'
     and payload->>'billedPeriodId' = '${current.id}'; commit;`,
)
await until('Financial and Fiscal to consume the replay', async () =>
  sql('horizon_financial', `select count(*) from inbox where tenant_id = '${tenantId}' and event_id = '${replayId}'`) === '1' &&
  sql('horizon_fiscal', `select count(*) from inbox where tenant_id = '${tenantId}' and event_id = '${replayId}'`) === '1',
)
assert.equal(titlesOf(current.id), `1:draft/CT-${current.id.slice(-8).toUpperCase()}`)
assert.equal((await intakesOf(current)).length, 1)
assert.equal(
  sql('horizon_fiscal', `select count(*) from fiscal_service_origins where tenant_id = '${tenantId}' and source_document_type = 'contract-period' and source_id = '${current.lines[0].entryId}'`),
  '1',
)
evidence.replay = { eventId: replayId, titles: titlesOf(current.id), intakes: 1 }

// --- a billed month never changes; a later one does ------------------------------------------
const lineOf = { lineId: randomUUID(), itemId: supportId, quantity: '3' }
const refusedAmendment = await call(`/sales/contracts/${billedId}/amendments`, {
  method: 'POST',
  body: { effectiveFrom: month(0), lines: [lineOf], recurrence: 'monthly', reason: 'Tentativa de mudar o mês faturado' },
})
assert.equal(refusedAmendment.status, 409, JSON.stringify(refusedAmendment.body))
await ok(`/sales/contracts/${billedId}/amendments`, {
  method: 'POST',
  body: { effectiveFrom: month(1), lines: [lineOf], recurrence: 'monthly', reason: 'Terceiro posto a partir do mês que vem' },
})
const schedule = (await ok(`/sales/contracts/${billedId}/schedule?from=${month(-1)}&to=${month(1)}`)).periods
assert.deepEqual(
  schedule.map((period) => [period.competence, period.revision, period.amount, Boolean(period.billedPeriodId)]),
  [
    [lastMonth, 1, '90000', true],
    [thisMonth, 1, '90000', true],
    [month(1).slice(0, 7), 2, '135000', false],
  ],
)

// --- a credit withdraws the receivable and cancels the NFS-e, keeping the period --------------
await ok(`/sales/contracts/${billedId}/periods/${thisMonth}/credit`, {
  method: 'POST',
  body: { reasonCode: 'billing-error', reason: 'Faturado com o posto errado' },
})
await until('the receivable to be withdrawn', async () =>
  titlesOf(current.id) === `1:cancelled/CT-${current.id.slice(-8).toUpperCase()}`,
)
const withdrawn = await until('the NFS-e to be cancelled', async () => {
  const [intake] = await intakesOf(current)
  if (intake?.status === 'cancellation-refused') throw new Error(intake.reason)
  return intake?.status === 'withdrawn' ? intake : undefined
})
assert.equal((await ok(`/fiscal/service-documents/${withdrawn.documentId}`)).status, 'cancelled')
await until('Sales to follow the cancellation', async () => {
  const after = await billed()
  return after[1]?.lines.every((line) => line.nfse.status === 'cancelled') ? after : undefined
})
const kept = await billed()
assert.equal(kept.length, 2)
assert.equal(kept[1].credit.reasonCode, 'billing-error')
assert.equal(kept[1].value, '90000')
assert.equal(kept[0].credit, null)
const again = await call(`/sales/contracts/${billedId}/periods/${thisMonth}/bill`, { method: 'POST' })
assert.equal(again.status, 409, JSON.stringify(again.body))
evidence.credit = {
  billedPeriodId: current.id,
  title: titlesOf(current.id),
  nfse: 'cancelled',
  periodsKept: kept.length,
}

const overview = await ok('/sales/contract-billing/overview')
assert.ok(overview.runs.some((row) => row.id === run.id))
evidence.overview = {
  runs: overview.runs.length,
  awaitingReceivable: overview.awaitingReceivable.length,
  awaitingNfse: overview.awaitingNfse.length,
}

await ok(`/fiscal/service-issuance-policies/${establishmentId}`, {
  method: 'PUT',
  body: { mode: 'review', series: 1, reason: 'Revisão por pessoa restaurada após o smoke' },
})
evidence.result = 'passed'
console.log(JSON.stringify(evidence, null, 2))
