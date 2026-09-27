#!/usr/bin/env node
/**
 * Phase 53 services golden path on the local stack, through Kong, with the deterministic
 * NFS-e simulator. It closes Phase K by proving both of its exit criteria end to end.
 *
 *   1. One-off services: a proposal with a service is accepted and converted into a
 *      service order, which is started, delivered and accepted. The delivery raises one
 *      receivable in Financial and one NFS-e in Fiscal, and Sales shows both.
 *   2. Recurring services: a monthly contract from two months ago is billed for two months
 *      by batch runs, then amended from next month. The billed months keep their revision
 *      and amount, and a change at a billed month is refused. Re-running a month under a
 *      new key, repeating it under its key and replaying its event add no title, fiscal
 *      request or NFS-e. A credit withdraws the receivable and cancels the NFS-e, and the
 *      period stays.
 *
 *   node scripts/phase53-golden-path.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
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

function cnpj() {
  const digits = [...Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)), 0, 0, 0, 1]
  for (const weights of [
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  ]) {
    const rest = digits.reduce((sum, value, index) => sum + value * weights[index], 0) % 11
    digits.push(rest < 2 ? 0 : 11 - rest)
  }
  return digits.join('')
}

/** The first day of the month `months` from the current UTC month. */
const month = (months) => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1)).toISOString().slice(0, 10)
}
const competence = (months) => month(months).slice(0, 7)
const ref = (prefix, id) => `${prefix}-${id.slice(-8).toUpperCase()}`
const evidence = { checkedAt: new Date().toISOString(), tenantId }
const establishmentId = tenantId
const performedOn = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())

// --- a priced service with its fiscal profile, and a customer the NFS-e can go to -----------
const stamp = Date.now().toString(36).toUpperCase()
const [unit] = (await ok('/catalog/units')).data
const item = await ok('/catalog/items', {
  method: 'POST',
  body: { kind: 'service', sku: `GP53-${stamp}`, name: `Manutenção preventiva ${stamp}`, unitId: unit.id },
})
const serviceId = item.id ?? item.itemId
const lists = await ok('/catalog/price-lists')
const priceList = (lists.data ?? lists).find((row) => row.currency === 'BRL')
await ok(`/catalog/price-lists/${priceList.id}/prices/${serviceId}`, {
  method: 'PUT',
  body: { amount: '80000', currency: 'BRL' },
})
await until('Sales to project the priced service', async () =>
  sql('horizon_sales', `select kind from catalog_items where tenant_id = '${tenantId}' and item_id = '${serviceId}' and unit_price is not null`) === 'service',
)
await until('the service fiscal profile', async () => {
  const saved = await call('/fiscal/service-profiles', {
    method: 'POST',
    body: {
      itemId: serviceId,
      nationalTaxCode: '010101',
      nbsCode: '115022000',
      issTaxation: '1',
      description: 'Manutenção preventiva de sistemas',
      effectiveFrom: '2026-01-01',
      reason: 'Classificação revisada no golden path da fase 53',
    },
  })
  if (saved.status >= 400) throw new Error(JSON.stringify(saved.body))
  return saved.body
})
const party = await ok('/parties/parties', {
  method: 'POST',
  body: {
    kind: 'organization',
    taxId: cnpj(),
    roles: ['customer'],
    legalName: `Cliente Golden Path Serviços ${stamp} LTDA`,
    email: `golden53-${stamp.toLowerCase()}@example.com`,
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
  body: { mode: 'automatic', series: 53, reason: 'Emissão automática para o golden path da fase 53' },
})

const titlesOf = (originType, documentId) =>
  sql('horizon_financial', `select count(*) || ':' || coalesce(string_agg(status, ','), '') from titles where tenant_id = '${tenantId}' and origin_type = '${originType}' and origin_document_id = '${documentId}'`)
const intakes = async (documentType, period) =>
  (await ok(`/fiscal/service-intakes?documentType=${documentType}&period=${period}`)).data
const authorized = async (intake) =>
  until(`the NFS-e of entry ${intake.sourceKey.id}`, async () => {
    const read = await ok(`/fiscal/service-documents/${intake.documentId}`)
    if (read.status === 'rejected') throw new Error(`NFS-e rejected: ${intake.documentId}`)
    return read.status === 'authorized' ? read : undefined
  })

try {
  // === 1. proposal → service order → delivery → receivable and NFS-e ===========================
  const quote = await ok('/sales/quotes', {
    method: 'POST',
    body: { customerId, lines: [{ lineId: randomUUID(), itemId: serviceId, quantity: '1' }] },
  })
  const quoteId = quote.quoteId ?? quote.id
  await ok(`/sales/quotes/${quoteId}/send`, { method: 'POST' })
  await ok(`/sales/quotes/${quoteId}/accept`, { method: 'POST' })
  const conversion = await ok(`/sales/quotes/${quoteId}/order`, { method: 'POST', body: {} })
  assert.equal(conversion.orderId, null)
  const { serviceOrderId } = conversion
  await ok(`/sales/service-orders/${serviceOrderId}/start`, { method: 'POST' })
  const delivery = await ok(`/sales/service-orders/${serviceOrderId}/deliveries`, {
    method: 'POST',
    body: { performedOn },
  })
  await ok(`/sales/service-orders/${serviceOrderId}/accept`, { method: 'POST' })
  await until('the receivable of the delivery', async () =>
    titlesOf('sales-service-delivery', delivery.deliveryId) === '1:draft',
  )
  const [deliveryIntake] = await until('the NFS-e of the delivery', async () => {
    const found = (await intakes('service-delivery', performedOn.slice(0, 7))).filter(
      (intake) => intake.deliveryId === delivery.deliveryId,
    )
    if (found[0]?.status === 'blocked') throw new Error(found[0].reason)
    return found[0]?.status === 'issuing' ? found : undefined
  })
  const deliveryNfse = await authorized(deliveryIntake)
  const shown = await until('Sales to show the delivery NFS-e', async () => {
    const read = await ok(`/sales/service-orders/${serviceOrderId}`)
    const entry = read.deliveries[0]?.entries[0]
    return entry?.nfse?.status === 'authorized' ? read : undefined
  })
  assert.equal(shown.status, 'accepted')
  assert.equal(shown.quoteId, quoteId)
  evidence.oneOff = {
    quote: ref('QT', quoteId),
    serviceOrder: ref('OS', serviceOrderId),
    delivery: ref('SV', delivery.deliveryId),
    receivable: titlesOf('sales-service-delivery', delivery.deliveryId),
    nfse: { documentId: deliveryNfse.id, number: deliveryNfse.nfseNumber, shownInSales: 'authorized' },
  }

  // === 2. contract → two billed months → amendment → re-run → credit ===========================
  const { contractId } = await ok('/sales/contracts', {
    method: 'POST',
    body: {
      customerId,
      lines: [{ lineId: randomUUID(), itemId: serviceId, quantity: '1', unitPrice: '60000' }],
      recurrence: 'monthly',
      startsOn: month(-2),
      billingDay: 1,
      paymentTermDays: [10],
      notes: 'Contrato do golden path da fase 53',
    },
  })
  await ok(`/sales/contracts/${contractId}/activate`, { method: 'POST' })
  const mine = (run) => run.items.find((row) => row.contractId === contractId)
  const firstRun = await ok('/sales/billing-runs', { method: 'POST', body: { competence: competence(-2) } })
  const secondKey = randomUUID()
  const secondRun = await ok('/sales/billing-runs', {
    method: 'POST',
    body: { competence: competence(-1) },
    key: secondKey,
  })
  assert.equal(mine(firstRun).outcome, 'billed')
  assert.equal(mine(secondRun).outcome, 'billed')
  const billed = async () => (await ok(`/sales/contracts/${contractId}/billed-periods`)).periods
  const [first, second] = await billed()
  assert.deepEqual([first.competence, second.competence], [competence(-2), competence(-1)])
  for (const period of [first, second])
    await until(`the receivable of ${period.competence}`, async () =>
      titlesOf('sales-contract-period', period.id) === '1:draft',
    )
  const periodIntake = async (period) =>
    (await intakes('contract-period', period.competence)).filter((intake) => intake.billedPeriodId === period.id)
  for (const period of [first, second]) {
    const [intake] = await until(`the NFS-e of ${period.competence}`, async () => {
      const found = await periodIntake(period)
      if (found[0]?.status === 'blocked') throw new Error(found[0].reason)
      return found[0]?.status === 'issuing' ? found : undefined
    })
    await authorized(intake)
  }

  // An amendment never reaches a billed month; from next month it applies.
  const refused = await call(`/sales/contracts/${contractId}/amendments`, {
    method: 'POST',
    body: {
      effectiveFrom: month(-1),
      lines: [{ lineId: randomUUID(), itemId: serviceId, quantity: '2', unitPrice: '60000' }],
      recurrence: 'monthly',
      reason: 'Tentativa de mudar um mês faturado',
    },
  })
  assert.equal(refused.status, 409, JSON.stringify(refused.body))
  await ok(`/sales/contracts/${contractId}/amendments`, {
    method: 'POST',
    body: {
      effectiveFrom: month(1),
      lines: [{ lineId: randomUUID(), itemId: serviceId, quantity: '2', unitPrice: '60000' }],
      recurrence: 'monthly',
      reason: 'Segundo posto a partir do mês que vem',
    },
  })
  const schedule = (await ok(`/sales/contracts/${contractId}/schedule?from=${month(-2)}&to=${month(1)}`)).periods
  assert.deepEqual(
    schedule.map((period) => [period.competence, period.revision, period.amount, Boolean(period.billedPeriodId)]),
    [
      [competence(-2), 1, '60000', true],
      [competence(-1), 1, '60000', true],
      [competence(0), 1, '60000', false],
      [competence(1), 2, '120000', false],
    ],
  )
  const afterAmendment = await billed()
  assert.deepEqual(
    afterAmendment.map((period) => [period.id, period.revision, period.value]),
    [first, second].map((period) => [period.id, period.revision, period.value]),
  )

  // Re-running, repeating the run and replaying its event add nothing.
  const repeated = await ok('/sales/billing-runs', {
    method: 'POST',
    body: { competence: competence(-1) },
    key: secondKey,
  })
  assert.equal(repeated.id, secondRun.id)
  const rerun = await ok('/sales/billing-runs', { method: 'POST', body: { competence: competence(-1) } })
  assert.deepEqual([mine(rerun).outcome, mine(rerun).reason], ['skipped', 'already-billed'])
  const replayId = randomUUID()
  sql(
    'horizon_sales',
    `begin; select set_config('app.current_tenant', '${tenantId}', true);
     insert into outbox (id, tenant_id, event_id, event_type, event_version, occurred_at, trace_id, payload)
     select '${replayId}', tenant_id, '${replayId}', event_type, event_version, now(), trace_id, payload
     from outbox where tenant_id = '${tenantId}' and event_type = 'sales.contract-period.billed'
       and payload->>'billedPeriodId' = '${second.id}'; commit;`,
  )
  await until('Financial and Fiscal to consume the replay', async () =>
    sql('horizon_financial', `select count(*) from inbox where tenant_id = '${tenantId}' and event_id = '${replayId}'`) === '1' &&
    sql('horizon_fiscal', `select count(*) from inbox where tenant_id = '${tenantId}' and event_id = '${replayId}'`) === '1',
  )
  assert.equal(titlesOf('sales-contract-period', second.id), '1:draft')
  assert.equal((await periodIntake(second)).length, 1)
  assert.equal(
    sql('horizon_fiscal', `select count(*) from fiscal_documents d join fiscal_service_origins o on o.tenant_id = d.tenant_id and o.id = d.service_origin_id where d.tenant_id = '${tenantId}' and o.source_document_type = 'contract-period' and o.source_id = '${second.lines[0].entryId}'`),
    '1',
  )

  // A credit withdraws the receivable and cancels the NFS-e; the period stays.
  await ok(`/sales/contracts/${contractId}/periods/${second.competence}/credit`, {
    method: 'POST',
    body: { reasonCode: 'not-provided', reason: 'O posto ficou fechado no mês' },
  })
  await until('the receivable to be withdrawn', async () =>
    titlesOf('sales-contract-period', second.id) === '1:cancelled',
  )
  const withdrawn = await until('the NFS-e to be cancelled', async () => {
    const [intake] = await periodIntake(second)
    if (intake?.status === 'cancellation-refused') throw new Error(intake.reason)
    return intake?.status === 'withdrawn' ? intake : undefined
  })
  assert.equal((await ok(`/fiscal/service-documents/${withdrawn.documentId}`)).status, 'cancelled')
  const kept = await until('Sales to show the cancellation', async () => {
    const periods = await billed()
    return periods[1]?.lines[0]?.nfse?.status === 'cancelled' ? periods : undefined
  })
  assert.equal(kept.length, 2)
  assert.equal(kept[1].credit.reasonCode, 'not-provided')
  assert.equal(kept[0].credit, null)
  assert.equal(titlesOf('sales-contract-period', first.id), '1:draft')
  evidence.recurring = {
    contract: ref('CTR', contractId),
    runs: { [competence(-2)]: firstRun.id, [competence(-1)]: secondRun.id, rerun: rerun.id },
    billed: kept.map((period) => ({
      competence: period.competence,
      revision: period.revision,
      value: period.value,
      title: titlesOf('sales-contract-period', period.id),
      nfse: period.lines[0].nfse.status,
      credited: Boolean(period.credit),
    })),
    amendment: { refusedAtBilledMonth: refused.status, appliesFrom: competence(1) },
    replay: replayId,
  }
  evidence.result = 'passed'
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await ok(`/fiscal/service-issuance-policies/${establishmentId}`, {
    method: 'PUT',
    body: { mode: 'review', series: 1, reason: 'Revisão por pessoa restaurada após o golden path' },
  })
}
