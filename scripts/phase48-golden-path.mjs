#!/usr/bin/env node
/**
 * Phase 48 golden path on the local stack, through Kong, with deterministic authorities.
 *
 *   1. Sales: quote -> accepted -> order -> dispatched shipment -> NF-e 55 authorized in
 *      simulation; one stock movement and one receivable for the shipment, and the fiscal
 *      authorization adds none. (A warehouse under a dispatch policy would instead wait for
 *      a production authorization before dispatch; simulation never produces one.)
 *   2. Purchasing: supplier XML -> receipt -> reconciliation -> payable match (the Phase 44
 *      smoke, run as a child).
 *   3. Support: the worklist and the overview read the new document; an audited outbox
 *      replay republishes its events and changes no stock or money.
 *
 *   node scripts/phase48-golden-path.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
 *     [--postgres-container horizon-postgres] [--fiscal-container horizon-fiscal]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
const fiscalContainer = flag('fiscal-container', 'horizon-fiscal')

const operator = execFileSync(
  process.execPath,
  [
    join(root, 'infra/scripts/mint-dev-token.mjs'),
    '--tenant',
    tenantId,
    '--sub',
    randomUUID(),
    ...[
      'parties:admin',
      'sales:admin',
      'financial:admin',
      'inventory:admin',
      'catalog:admin',
      'fiscal:admin',
    ].flatMap((role) => ['--role', role]),
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

function sql(database, statement) {
  return execFileSync(
    'docker',
    ['exec', postgresContainer, 'psql', '-U', 'postgres', '-d', database, '-At', '-c', statement],
    { encoding: 'utf8' },
  ).trim()
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5000))

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

const evidence = { checkedAt: new Date().toISOString(), tenantId }

// --- 1. quote -> order -> NF-e authorized -> dispatch ----------------------------------------
const profile = JSON.parse(
  execFileSync('docker', ['exec', fiscalContainer, 'printenv', 'FISCAL_SIMULATION_PROFILE_JSON'], {
    encoding: 'utf8',
  }),
)
const itemId = Object.keys(profile.lineFacts)[0]
const [warehouse] = await ok('/inventory/warehouses')
const onHand = async () =>
  Number(
    (await ok('/inventory/warehouses'))
      .find((entry) => entry.id === warehouse.id)
      ?.balances.find((balance) => balance.itemId === itemId)?.onHand ?? '0',
  )

const created = await ok('/parties/parties', {
  method: 'POST',
  body: {
    kind: 'organization',
    taxId: cnpj(),
    roles: ['customer'],
    legalName: 'Cliente Golden Path Fase 48 LTDA',
    email: `golden-${Date.now()}@example.com`,
    phone: '11999990000',
    address: 'Rua das Flores, 7, São Paulo',
  },
})
const customerId = created.id ?? created.partyId
await ok(`/parties/parties/${customerId}/fiscal-profile`, {
  method: 'PUT',
  body: {
    effectiveFrom: '2026-01-01',
    stateRegistration: '111222333',
    municipalRegistration: null,
    taxpayerIndicator: 'contributor',
    finalConsumer: false,
    address: {
      street: 'Rua das Flores',
      number: '7',
      complement: null,
      district: 'Centro',
      city: 'São Paulo',
      municipalityCode: '3550308',
      state: 'SP',
      postalCode: '01001000',
      country: 'BR',
    },
  },
})
await until('Sales to know the customer', async () =>
  (await ok('/sales/customers')).some((entry) => (entry.id ?? entry.partyId) === customerId),
)

const lineId = randomUUID()
const quote = await ok('/sales/quotes', {
  method: 'POST',
  body: { customerId, lines: [{ lineId, itemId, quantity: '2' }] },
})
const quoteId = quote.quoteId ?? quote.id
await ok(`/sales/quotes/${quoteId}/send`, { method: 'POST' })
await ok(`/sales/quotes/${quoteId}/accept`, { method: 'POST' })
const converted = await ok(`/sales/quotes/${quoteId}/order`, {
  method: 'POST',
  body: { fulfillmentWarehouseId: warehouse.id },
})
const orderId = converted.orderId ?? converted.id
await until('the order to be confirmed', async () =>
  (await ok(`/sales/orders/${orderId}`)).status === 'confirmed',
)
const orderLine = (await ok(`/sales/orders/${orderId}`)).requestedLines[0].lineId
const picked = await ok('/sales/shipments', {
  method: 'POST',
  body: { orderId, lines: [{ lineId: orderLine, quantity: '2' }] },
})
const shipmentId = picked.shipmentId ?? picked.id
const stockBefore = await onHand()
await ok(`/sales/shipments/${shipmentId}/pack`, { method: 'POST', body: {} })
await ok(`/sales/shipments/${shipmentId}/dispatch`, { method: 'POST', body: {} })
const intentId = await until('the Sales fiscal origin', async () =>
  sql(
    'horizon_fiscal',
    `select id from fiscal_intents where tenant_id = '${tenantId}' and origin_id = '${shipmentId}' and purpose = 'original'`,
  ),
)
evidence.sale = { quoteId, orderId, shipmentId, intentId }
const stockAfter = await until('the stock movement', async () => {
  const value = await onHand()
  return value === stockBefore - 2 ? value : undefined
})
const receivables = await until('the receivable', async () => {
  const titles = (await ok(`/financial/receivables?partyId=${customerId}&limit=100`)).data ?? []
  return titles.length ? titles : undefined
})

const draft = await ok('/fiscal/documents', {
  method: 'POST',
  body: {
    origin: { kind: 'sales', intentId },
    model: '55',
    environment: 'simulation',
    establishmentId: tenantId,
    series: 1,
  },
})
await until('the document to become ready', async () => {
  const ready = await call(`/fiscal/documents/${draft.id}/validate`, { method: 'POST' })
  if (ready.status >= 400) throw new Error(JSON.stringify(ready.body))
  return ready.body.document.status === 'ready'
})
const queued = await call(`/fiscal/documents/${draft.id}/issue`, { method: 'POST' })
assert.equal(queued.status, 202, JSON.stringify(queued.body))
const authorized = await until('NF-e authorization', async () => {
  const found = await ok(`/fiscal/documents/${draft.id}`)
  return ['authorized', 'rejected'].includes(found.status) ? found : undefined
})
assert.equal(authorized.status, 'authorized')
assert.equal(authorized.simulated, true)

const worklist = await ok('/fiscal/documents?model=55&limit=5')
const row = worklist.data.find((entry) => entry.id === draft.id)
assert.ok(row, 'The worklist does not show the authorized NF-e')
assert.equal(row.status, 'authorized')
assert.equal(row.simulated, true)
assert.equal(row.fiscalValue, false)
assert.equal(row.pending, null)

const listed = await ok(`/fiscal/documents/${draft.id}/artifacts`)
const artifacts = []
for (const artifact of listed.artifacts) {
  const response = await fetch(
    `${baseUrl}/fiscal/documents/${draft.id}/artifacts/${artifact.kind}?digest=${artifact.digest}`,
    { headers: { authorization: `Bearer ${operator}` } },
  )
  assert.equal(response.status, 200)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.digest)
  artifacts.push({ kind: artifact.kind, digest: artifact.digest, byteSize: bytes.length })
}
assert.ok(artifacts.some((entry) => entry.kind === 'authorization_protocol'))

await settle()
// The authorization added no stock movement and no second receivable.
assert.equal(await onHand(), stockAfter)
assert.equal(((await ok(`/financial/receivables?partyId=${customerId}&limit=100`)).data ?? []).length, 1)
evidence.nfe = {
  documentId: draft.id,
  number: authorized.number,
  accessKeyModel: authorized.accessKey.slice(20, 22),
  artifacts,
  stockDelta: stockAfter - stockBefore,
  receivables: receivables.length,
}
assert.equal(evidence.nfe.accessKeyModel, '55')
assert.equal(receivables.length, 1)

// --- 2. supplier XML -> receipt -> payable match ---------------------------------------------
const purchase = JSON.parse(
  execFileSync(process.execPath, [join(root, 'scripts/phase44-smoke.mjs'), '--tenant', tenantId], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }),
)
const imported = await ok(`/fiscal/imports/${purchase.importId}`)
assert.equal(imported.status, 'reconciled')
// The smoke already proved exactly one posted payable in Financial. The ids the
// reconciliation lists are what Fiscal's payable projection held at commit time.
evidence.purchase = {
  importId: purchase.importId,
  receiptId: purchase.receiptId,
  stockDelta: purchase.after.stockDelta,
  receipts: purchase.after.receipts,
  payables: purchase.after.payables.filter((title) => title.stage !== 'forecast').length,
  importStatus: imported.status,
  payablesLinkedAtCommit: imported.reconciliation.payableTitleIds.length,
}

// --- 3. support reads and an audited replay ------------------------------------------------
// The purchase received stock of the same item; the replay is measured from here.
const stockBeforeReplay = await onHand()
const replay = JSON.parse(
  execFileSync(
    'docker',
    [
      'exec',
      fiscalContainer,
      'node',
      'dist/support-cli.js',
      'replay-outbox',
      '--tenant',
      tenantId,
      '--actor',
      'phase48-golden-path',
      '--document',
      draft.id,
      '--reason',
      'Golden path: republish the NF-e events and prove no effect repeats',
      '--limit',
      '10',
    ],
    { encoding: 'utf8' },
  ),
)
assert.ok(replay.changed.length >= 1, JSON.stringify(replay))
await until('the replay to be published', async () =>
  sql(
    'horizon_fiscal',
    `select count(*) from fiscal_outbox_replays where tenant_id = '${tenantId}' and delivered_at is null`,
  ) === '0',
)
await settle()
assert.equal(await onHand(), stockBeforeReplay)
const receivablesAfter = (await ok(`/financial/receivables?partyId=${customerId}&limit=100`)).data
assert.equal(receivablesAfter.length, 1)
const overview = await ok('/fiscal/support/overview')
assert.equal(overview.simulationOnly, true)
evidence.support = {
  replayed: replay.changed.map((entry) => entry.detail),
  queue: overview.queue,
  unknownOutcomes: overview.unknownOutcomes,
  outbox: overview.outbox,
  capabilities: overview.capabilities.map(
    (entry) => `${entry.model} ${entry.environment} ${entry.jurisdiction.code} ${entry.operation}`,
  ),
  stockDeltaFromReplay: (await onHand()) - stockBeforeReplay,
  receivablesAfterReplay: receivablesAfter.length,
}
console.log(JSON.stringify(evidence, null, 2))
