#!/usr/bin/env node
/**
 * Phase 46 local-stack smoke through Kong. A real Sales shipment to a final consumer (a
 * person with a CPF) becomes an NFC-e model 65: its own XML with the version 3 QR code,
 * its own DANFE NFC-e, and a cancellation inside the reviewed window. The same sale
 * cannot also become an NF-e, a contributor cannot receive an NFC-e, and stock and money
 * keep one effect per shipment.
 *
 *   node scripts/phase46-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
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
    ...['parties:admin', 'sales:admin', 'financial:admin', 'inventory:admin', 'catalog:admin', 'fiscal:admin'].flatMap(
      (role) => ['--role', role],
    ),
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

/** The only lookup without an API yet: the Sales intent behind a shipment (Phase 48 screen). */
const intentOf = (shipmentId) =>
  sql(
    'horizon_fiscal',
    `select id from fiscal_intents where tenant_id = '${tenantId}' and origin_id = '${shipmentId}' and purpose = 'original'`,
  )

function checkDigits(base, weightsFor) {
  const digits = [...base]
  for (const weights of weightsFor) {
    const rest = digits.reduce((sum, value, index) => sum + value * weights[index], 0) % 11
    digits.push(rest < 2 ? 0 : 11 - rest)
  }
  return digits.join('')
}
const cpf = () =>
  checkDigits(
    Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)),
    [
      [10, 9, 8, 7, 6, 5, 4, 3, 2],
      [11, 10, 9, 8, 7, 6, 5, 4, 3, 2],
    ],
  )
const cnpj = () =>
  checkDigits(
    [...Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)), 0, 0, 0, 1],
    [
      [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
      [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
    ],
  )

const address = {
  street: 'Rua das Flores',
  number: '7',
  complement: null,
  district: 'Centro',
  city: 'São Paulo',
  municipalityCode: '3550308',
  state: 'SP',
  postalCode: '01001000',
  country: 'BR',
}

async function customer(kind, legalName) {
  const taxId = kind === 'person' ? cpf() : cnpj()
  const created = await ok('/parties/parties', {
    method: 'POST',
    body: {
      kind,
      taxId,
      roles: ['customer'],
      legalName,
      email: `${kind}-${Date.now()}@example.com`,
      phone: '11999990000',
      address: 'Rua das Flores, 7, São Paulo',
    },
  })
  const id = created.id ?? created.partyId
  await ok(`/parties/parties/${id}/fiscal-profile`, {
    method: 'PUT',
    body: {
      effectiveFrom: '2026-01-01',
      stateRegistration: kind === 'person' ? null : '111222333',
      municipalRegistration: null,
      taxpayerIndicator: kind === 'person' ? 'non-contributor' : 'contributor',
      finalConsumer: kind === 'person',
      address,
    },
  })
  await until('Sales to know the customer', async () =>
    (await ok('/sales/customers')).some((entry) => (entry.id ?? entry.partyId) === id),
  )
  return { id, taxId }
}

async function ship(customerId, itemId, warehouseId) {
  const lineId = randomUUID()
  const placed = await ok('/sales/orders', {
    method: 'POST',
    body: {
      customerId,
      fulfillmentWarehouseId: warehouseId,
      currency: 'BRL',
      lines: [{ lineId, itemId, quantity: '2' }],
    },
  })
  const orderId = placed.orderId ?? placed.id
  await until('the sales order to be confirmed', async () =>
    (await ok(`/sales/orders/${orderId}`)).status === 'confirmed',
  )
  const picked = await ok('/sales/shipments', {
    method: 'POST',
    body: { orderId, lines: [{ lineId, quantity: '2' }] },
  })
  const shipmentId = picked.shipmentId ?? picked.id
  await ok(`/sales/shipments/${shipmentId}/pack`, { method: 'POST', body: {} })
  await ok(`/sales/shipments/${shipmentId}/dispatch`, { method: 'POST', body: {} })
  const intentId = await until('the Sales fiscal origin', async () => intentOf(shipmentId))
  return { orderId, shipmentId, intentId }
}

const draftBody = (intentId, model) => ({
  origin: { kind: 'sales', intentId },
  model,
  environment: 'simulation',
  establishmentId: tenantId,
  series: 1,
})

async function validated(documentId) {
  return until('the document to become ready', async () => {
    const ready = await call(`/fiscal/documents/${documentId}/validate`, { method: 'POST' })
    if (ready.status >= 400) throw new Error(JSON.stringify(ready.body))
    return ready.body.document.status === 'ready'
  })
}

async function artifact(document, kind, digest) {
  const response = await fetch(
    `${baseUrl}/fiscal/documents/${document.id}/artifacts/${kind}?digest=${digest}`,
    { headers: { authorization: `Bearer ${operator}` } },
  )
  assert.equal(response.status, 200)
  return Buffer.from(await response.arrayBuffer())
}

const evidence = { checkedAt: new Date().toISOString(), tenantId }
const kinds = await ok('/fiscal/document-kinds')
const consumerKind = kinds.kinds.find((entry) => entry.kind === 'consumer-sale')
assert.equal(consumerKind.model, '65')
assert.equal(consumerKind.supported, true)
assert.equal(kinds.kinds.find((entry) => entry.kind === 'counter-sale').supported, false)
assert.equal(kinds.kinds.find((entry) => entry.kind === 'consumer-sale-offline').supported, false)
assert.deepEqual(kinds.eventFlows.find((entry) => entry.model === '65').flows, ['cancellation'])

const profile = JSON.parse(
  execFileSync('docker', ['exec', 'horizon-fiscal', 'printenv', 'FISCAL_SIMULATION_PROFILE_JSON'], {
    encoding: 'utf8',
  }),
)
assert.ok(profile.consumer?.capabilityId, 'The issuance profile lacks the Phase 46 consumer block')
const itemId = Object.keys(profile.lineFacts)[0]
const [warehouse] = await ok('/inventory/warehouses')
const onHand = async () =>
  Number(
    (await ok('/inventory/warehouses'))
      .find((entry) => entry.id === warehouse.id)
      ?.balances.find((balance) => balance.itemId === itemId)?.onHand ?? '0',
  )

// --- a consumer sale becomes an NFC-e ------------------------------------------------------
const consumer = await customer('person', 'Consumidora Smoke Fase 46')
const stockStart = await onHand()
const sale = await ship(consumer.id, itemId, warehouse.id)
const createKey = randomUUID()
const draft = await ok('/fiscal/documents', { method: 'POST', body: draftBody(sale.intentId, '65'), key: createKey })
const again = await ok('/fiscal/documents', { method: 'POST', body: draftBody(sale.intentId, '65'), key: createKey })
assert.equal(again.id, draft.id)
const otherModel = await call('/fiscal/documents', { method: 'POST', body: draftBody(sale.intentId, '55') })
assert.equal(otherModel.status, 409)
assert.equal(otherModel.body.code, 'MODEL_CONFLICT')
await validated(draft.id)
const queued = await call(`/fiscal/documents/${draft.id}/issue`, { method: 'POST' })
assert.equal(queued.status, 202, JSON.stringify(queued.body))
const nfce = await until('NFC-e authorization', async () => {
  const found = await ok(`/fiscal/documents/${draft.id}`)
  return found.status === 'authorized' ? found : undefined
})
assert.equal(nfce.model, '65')
const xml = (await artifact(nfce, 'signed_xml', nfce.signedXmlDigest)).toString('utf8')
for (const fragment of ['<mod>65</mod>', '<tpImp>4</tpImp>', '<indFinal>1</indFinal>', '<indIEDest>9</indIEDest>', `<CPF>${consumer.taxId}</CPF>`, '<tPag>05</tPag>'])
  assert.ok(xml.includes(fragment), `NFC-e XML lacks ${fragment}`)
const qrCode = /<qrCode>([^<]+)<\/qrCode>/.exec(xml)?.[1]
assert.equal(qrCode, `https://nfce.simulacao.horizon.invalid/qrcode?p=${nfce.accessKey}|3|2`)
assert.ok(xml.indexOf('</infNFeSupl><Signature') > 0)
const listed = await ok(`/fiscal/documents/${nfce.id}/artifacts`)
const danfe = listed.artifacts.find(
  (entry) => entry.kind === 'danfe' && entry.sourceSchema === 'horizon-danfe-nfce-authorized-v1',
)
assert.ok(danfe, 'The authorized DANFE NFC-e is missing')
const pdf = await artifact(nfce, 'danfe', danfe.digest)
assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-')
// An 80 mm receipt roll: 226.77 pt wide.
assert.match(pdf.toString('latin1'), /MediaBox \[\s*0 0 226\.77/)
evidence.nfce = {
  documentId: nfce.id,
  shipmentId: sale.shipmentId,
  number: nfce.number,
  accessKeyModel: nfce.accessKey.slice(20, 22),
  qrCode: qrCode.replace(nfce.accessKey, '<chave>'),
  danfeDigest: danfe.digest,
  modelConflict: otherModel.body.code,
}

// --- a contributor cannot receive an NFC-e ------------------------------------------------
const company = await customer('organization', 'Cliente Contribuinte Smoke Fase 46 LTDA')
const companySale = await ship(company.id, itemId, warehouse.id)
const companyDraft = await ok('/fiscal/documents', { method: 'POST', body: draftBody(companySale.intentId, '65') })
const refused = await call(`/fiscal/documents/${companyDraft.id}/validate`, { method: 'POST' })
assert.equal(refused.status, 422, JSON.stringify(refused.body))
assert.equal(refused.body.code, 'CONSUMER_NOT_ELIGIBLE')
evidence.contributor = { documentId: companyDraft.id, validation: refused.body.code }

// --- cancellation inside the reviewed window ----------------------------------------------
const cancellation = await call(`/fiscal/documents/${nfce.id}/cancellation-requests`, {
  method: 'POST',
  body: { reason: 'Consumidora desistiu da compra no smoke da fase 46' },
})
assert.equal(cancellation.status, 202, JSON.stringify(cancellation.body))
const cancelled = await until('NFC-e cancellation', async () => {
  const found = await ok(`/fiscal/documents/${nfce.id}`)
  return found.status === 'cancelled' ? found : undefined
})
evidence.nfce.cancellation = cancelled.status

// --- effects stay with their owners -------------------------------------------------------
await new Promise((resolve) => setTimeout(resolve, 4000))
const stockEnd = await onHand()
const receivables = (await ok(`/financial/receivables?partyId=${consumer.id}&limit=100`)).data ?? []
const outcomes = sql(
  'horizon_fiscal',
  `select payload->>'outcome' from fiscal_outbox where tenant_id = '${tenantId}' and event_type = 'fiscal.consumer-document.simulation-outcome' and payload->>'documentId' = '${nfce.id}' order by created_at`,
)
  .split('\n')
  .filter(Boolean)
evidence.effects = {
  stockDelta: stockEnd - stockStart,
  consumerReceivables: receivables.map((title) => ({ status: title.status, stage: title.stage })),
  consumerOutcomes: outcomes,
}
// Two shipments of 2 left the warehouse; cancelling the NFC-e moved nothing back.
assert.equal(evidence.effects.stockDelta, -4)
assert.equal(receivables.length, 1)
assert.deepEqual(outcomes, ['authorized', 'cancelled'])
console.log(JSON.stringify(evidence, null, 2))
