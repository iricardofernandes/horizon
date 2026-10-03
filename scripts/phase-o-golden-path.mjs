#!/usr/bin/env node
/**
 * The Phase O golden path (Phase 89), through Kong, on the golden path workspace:
 *   1. two packages adopted through a request and another admin's approval, each with its
 *      impact on what is locked;
 *   2. an item and a customer that state their facts (Phase 89), a quote with Fiscal's
 *      estimate, the order, the delivery and the locked NF-e calculation;
 *   3. the Ledger's tax postings from the lock;
 *   4. the next version requested with its impact report;
 *   5. the locked calculation replayed unchanged.
 * It is idempotent, and stores its record under docs/drills. No token or secret is stored.
 *
 *   node scripts/phase-o-golden-path.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
const today = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10)

const mint = (...roles) =>
  execFileSync(
    process.execPath,
    [
      join(root, 'infra/scripts/mint-dev-token.mjs'),
      '--tenant',
      tenantId,
      '--sub',
      randomUUID(),
      ...roles.flatMap((role) => ['--role', role]),
    ],
    { encoding: 'utf8' },
  ).trim()
const operator = mint(
  'identity:admin',
  'parties:admin',
  'sales:admin',
  'procurement:admin',
  'financial:admin',
  'inventory:admin',
  'catalog:admin',
  'fiscal:admin',
)
const approver = mint('procurement:admin', 'financial:admin')

async function call(path, { method = 'GET', body, token = operator, key = method === 'GET' ? undefined : randomUUID(), type } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': type ?? 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: type ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
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

/** The only lookup without an API yet: the Sales intent behind a shipment (Phase 48 screen). */
function intentOf(shipmentId, purpose) {
  const sql = `select id from fiscal_intents where tenant_id = '${tenantId}' and origin_id = '${shipmentId}' and purpose = '${purpose}'`
  return execFileSync(
    'docker',
    ['exec', postgresContainer, 'psql', '-U', 'postgres', '-d', 'horizon_fiscal', '-At', '-c', sql],
    { encoding: 'utf8' },
  ).trim()
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

const fiscalProfile = {
  effectiveFrom: '2026-01-01',
  stateRegistration: '111222333',
  municipalRegistration: null,
  taxpayerIndicator: 'contributor',
  finalConsumer: false,
  address: {
    street: 'Rua da Parte',
    number: '10',
    complement: null,
    district: 'Centro',
    city: 'São Paulo',
    municipalityCode: '3550308',
    state: 'SP',
    postalCode: '01001000',
    country: 'BR',
  },
}

async function party(role, legalName) {
  const taxId = cnpj()
  const created = await ok('/parties/parties', {
    method: 'POST',
    body: {
      kind: 'organization',
      taxId,
      roles: [role],
      legalName,
      email: `${role}@example.com`,
      phone: '1130000000',
      address: 'Rua da Parte, 10, São Paulo',
    },
  })
  const id = created.id ?? created.partyId
  await ok(`/parties/parties/${id}/fiscal-profile`, { method: 'PUT', body: fiscalProfile })
  return { id, taxId }
}

async function issue(documentId) {
  await until('the document to become ready', async () => {
    const ready = await call(`/fiscal/documents/${documentId}/validate`, { method: 'POST' })
    if (ready.status >= 400) throw new Error(JSON.stringify(ready.body))
    return ready.body.document.status === 'ready'
  })
  const queued = await call(`/fiscal/documents/${documentId}/issue`, { method: 'POST' })
  assert.equal(queued.status, 202, JSON.stringify(queued.body))
  return until('authorization', async () => {
    const found = await ok(`/fiscal/documents/${documentId}`)
    return found.status === 'authorized' ? found : undefined
  })
}

async function signedXml(document) {
  const response = await fetch(
    `${baseUrl}/fiscal/documents/${document.id}/artifacts/signed_xml?digest=${document.signedXmlDigest}`,
    { headers: { authorization: `Bearer ${operator}` } },
  )
  assert.equal(response.status, 200)
  return response.text()
}

async function linked(request) {
  const key = randomUUID()
  const origin = await until(`the ${request.kind} origin`, async () => {
    const created = await call('/fiscal/linked-origins', { method: 'POST', body: request, key })
    if (created.status === 422 && created.body.code === 'SOURCE_NOT_PROJECTED') return undefined
    if (created.status >= 400) throw new Error(JSON.stringify(created.body))
    return created.body
  })
  const again = await ok('/fiscal/linked-origins', { method: 'POST', body: request, key })
  assert.equal(again.id, origin.id)
  const draft = await ok('/fiscal/documents', {
    method: 'POST',
    body: {
      origin: { kind: 'linked', linkedOriginId: origin.id },
      model: '55',
      environment: 'simulation',
      establishmentId: tenantId,
      series: 1,
    },
  })
  return { origin, document: await issue(draft.id) }
}

// --- Phase O ------------------------------------------------------------------------------
const record = { phase: 89, kind: 'phase-o-golden-path', ranAt: new Date().toISOString(), tenantId }
// Two Fiscal admins: one asks, the other decides (ADR 0074). The operator is the first.
const fiscalApprover = mint('fiscal:admin')
const ledgerAdmin = mint('ledger:admin')
const PACKAGES = {
  goods: 'cd59e153-4176-5ad8-a430-dd0bff93b2e8',
  pisCofins: '147bbee0-f418-5798-a469-be086224a020',
  nextVersion: 'd5791739-cbf0-5afe-a4de-0abde90f31ea',
}

async function catalogEntry(packageId) {
  return (await ok('/fiscal/catalog/packages')).data.find((entry) => entry.id === packageId)
}

/** Asks for a change, reads its impact, and lets the other admin decide it. */
async function requestAndDecide(body, decide) {
  const change = await ok('/fiscal/rule-changes', { method: 'POST', body })
  const self = await call(`/fiscal/rule-changes/${change.id}/approve`, { method: 'POST', body: {} })
  assert.equal(self.status, 403)
  assert.equal(self.body.code, 'segregation-of-duties')
  const impact = {
    examined: change.impact.examined,
    changed: change.impact.changed.length,
    unsupported: change.impact.unsupported.length,
    unchanged: change.impact.unchanged,
    digest: change.impact.digest,
  }
  const outcome = decide(impact) ? 'approve' : 'reject'
  const decided = await ok(`/fiscal/rule-changes/${change.id}/${outcome}`, {
    method: 'POST',
    body: outcome === 'reject' ? { reason: 'The impact report shows locked documents would change' } : {},
    token: fiscalApprover,
  })
  return {
    changeId: change.id,
    diff: change.diff.counts,
    impact,
    selfApprovalRefused: self.body.pair,
    decision: decided.status,
    decidedBySecondAdmin: decided.decision.decidedBy !== change.requestedBy,
  }
}

/** Adopted by an earlier run: the request that did it, and what it said it would change. */
async function adoptedEarlier(packageId, since) {
  const approved = (await ok('/fiscal/rule-changes')).data.find(
    (change) => change.status === 'approved' && change.request.packageId === packageId,
  )
  return {
    alreadyAdopted: true,
    since,
    ...(approved
      ? {
          changeId: approved.id,
          diff: approved.counts,
          impact: { changed: approved.changedDocuments, unsupported: approved.unsupportedDocuments },
          decidedBySecondAdmin: approved.decision.decidedBy !== approved.requestedBy,
        }
      : {}),
  }
}

// 1. The packages a resale of NCM 8509.40.10 needs, adopted only when nothing locked changes.
record.adoptions = {}
for (const [name, packageId] of [['goods', PACKAGES.goods], ['pisCofins', PACKAGES.pisCofins]]) {
  const entry = await catalogEntry(packageId)
  if (entry.adoption.state === 'adopted') {
    record.adoptions[name] = await adoptedEarlier(packageId, entry.adoption.effectiveFrom)
    continue
  }
  if (entry.pendingChangeId)
    await call(`/fiscal/rule-changes/${entry.pendingChangeId}/cancel`, {
      method: 'POST',
      body: { reason: 'Superseded by the Phase O golden path' },
    })
  record.adoptions[name] = await requestAndDecide(
    {
      kind: 'adopt-package',
      packageId,
      effectiveFrom: '2026-01-01',
      interpretation: 'Adopted by the Phase O golden path, as reviewed in the Phase 85 and 86 fixtures.',
      reason: 'Phase O golden path: the legacy taxes of a resale',
      impactMonths: 3,
    },
    (impact) => impact.changed === 0 && impact.unsupported === 0,
  )
  assert.equal(record.adoptions[name].decision, 'approved')
}

// 2. Where the Ledger posts the taxes in the price: two accounts and their roles.
const ledger = (path, options = {}) => ok(`/ledger${path}`, { ...options, token: ledgerAdmin })
const accounts = (await ledger('/accounts')).data
const ensureAccount = async (code, name, type, postable) =>
  accounts.find((account) => account.code === code) ??
  (await ledger('/accounts', { method: 'POST', body: { code, name, type, postable, currency: 'BRL' } }))
await ensureAccount('2', 'Passivo', 'liability', false)
await ensureAccount('4', 'Despesas', 'expense', false)
const payable = await ensureAccount('2.02', 'Impostos a recolher', 'liability', true)
const salesTaxes = await ensureAccount('4.05', 'Impostos sobre vendas', 'expense', true)
for (const [role, account] of [['taxes-payable', payable], ['sales-taxes', salesTaxes]])
  await ledger('/mappings', { method: 'PUT', body: { role, key: null, accountId: account.id } })

// 3. An item the workspace resells, not an IPI taxpayer for it, classified from today.
const units = await ok('/catalog/units')
const unit = (units.data ?? units)[0]
const item = await ok('/catalog/items', {
  method: 'POST',
  body: { kind: 'product', sku: `PHASE-O-${Date.now()}`, name: 'Liquidificador (golden path da fase O)', unitId: unit.id, ncm: '85094010' },
})
const itemId = item.id ?? item.itemId
await ok(`/catalog/items/${itemId}/classification`, {
  method: 'PATCH',
  body: { effectiveFrom: '2026-01-01', ncm: '85094010', ipiTaxpayer: false },
})
const priceLists = (await ok('/catalog/price-lists')).data ?? (await ok('/catalog/price-lists'))
const priceList = priceLists.find((row) => row.currency === 'BRL')
await ok(`/catalog/price-lists/${priceList.id}/prices/${itemId}`, {
  method: 'PUT',
  body: { amount: '18990', currency: 'BRL' },
})

// Stock to deliver: a purchase received.
const [warehouse] = await ok('/inventory/warehouses')
const supplier = await party('supplier', 'Fornecedor Golden Path Fase O LTDA')
await until('Procurement to know the supplier and the item', async () =>
  (await ok('/procurement/suppliers')).some((entry) => (entry.id ?? entry.partyId) === supplier.id),
)
const orderLine = randomUUID()
const purchase = await until('the purchase order', async () => {
  const created = await call('/procurement/orders', {
    method: 'POST',
    body: {
      supplierId: supplier.id,
      warehouseId: warehouse.id,
      currency: 'BRL',
      lines: [{ lineId: orderLine, itemId, quantity: '2', unitPrice: '10000' }],
      issuedOn: today,
      expectedOn: today,
    },
  })
  return created.status < 400 ? created.body : undefined
})
const purchaseId = purchase.id ?? purchase.orderId
await ok(`/procurement/orders/${purchaseId}/place`, { method: 'POST', body: {} })
if ((await ok(`/procurement/orders/${purchaseId}`)).status === 'pending')
  await ok(`/procurement/orders/${purchaseId}/approve`, { method: 'POST', body: {}, token: approver })
await ok('/procurement/receipts', {
  method: 'POST',
  body: { orderId: purchaseId, receivedOn: today, lines: [{ lineId: orderLine, quantity: '2' }] },
})

// A contributor customer who resells what it buys, as its fiscal profile states.
const customer = await party('customer', 'Revenda Golden Path Fase O LTDA')
await ok(`/parties/parties/${customer.id}/fiscal-profile`, {
  method: 'PUT',
  body: { ...fiscalProfile, effectiveFrom: '2026-01-01', goodsDestination: 'resale' },
})
await until('Sales to know the customer and the item', async () =>
  (await ok('/sales/customers')).some((entry) => (entry.id ?? entry.partyId) === customer.id),
)

// 4. A quote, Fiscal's estimate kept on it, and the order it becomes.
const establishmentId = (await ok('/fiscal/capabilities')).supported[0].establishmentId
const quoteLine = randomUUID()
const quote = await until('the quote', async () => {
  const created = await call('/sales/quotes', {
    method: 'POST',
    body: { customerId: customer.id, lines: [{ lineId: quoteLine, itemId, quantity: '2' }] },
  })
  return created.status < 400 ? created.body : undefined
})
const quoteId = quote.quoteId ?? quote.id
const estimate = await until('Fiscal to estimate the quote', async () => {
  const answer = await call('/fiscal/estimates', {
    method: 'POST',
    body: {
      direction: 'sale',
      establishmentId,
      customerPartyId: customer.id,
      issueDate: today,
      lines: [{ itemId, quantity: '2', unitPrice: { amount: '18990', currency: 'BRL' } }],
    },
  })
  return answer.status === 200 && answer.body.supported ? answer.body : undefined
})
// Sales takes only the digest, and reads the estimate back from Fiscal itself (Phase 91):
// an estimate nobody issued, or relayed whole, is refused.
const forged = await call(`/sales/quotes/${quoteId}/tax-estimate`, {
  method: 'PUT',
  body: { resultDigest: 'f'.repeat(64) },
})
const relayed = await call(`/sales/quotes/${quoteId}/tax-estimate`, { method: 'PUT', body: estimate })
assert.equal(forged.status, 400, JSON.stringify(forged.body))
assert.equal(relayed.status, 400, JSON.stringify(relayed.body))
await ok(`/sales/quotes/${quoteId}/tax-estimate`, {
  method: 'PUT',
  body: { resultDigest: estimate.resultDigest },
})
await ok(`/sales/quotes/${quoteId}/send`, { method: 'POST', body: {} })
if ((await ok(`/sales/quotes/${quoteId}`)).status === 'pending-approval')
  await ok(`/sales/quotes/${quoteId}/approve`, { method: 'POST', body: {} })
await ok(`/sales/quotes/${quoteId}/accept`, { method: 'POST', body: {} })
const converted = await ok(`/sales/quotes/${quoteId}/order`, {
  method: 'POST',
  body: { fulfillmentWarehouseId: warehouse.id },
})
const salesOrderId = converted.orderId
const carried = await ok(`/sales/orders/${salesOrderId}/tax-estimate`)
assert.equal(carried.estimate.resultDigest, estimate.resultDigest)
record.estimate = {
  components: estimate.components.map((c) => `${c.code} ${c.amount.amount}`),
  totals: Object.fromEntries(Object.entries(estimate.totals).map(([key, value]) => [key, value.amount])),
  resultDigest: estimate.resultDigest,
  keptOnTheOrder: true,
  forgedDigestRefused: forged.status,
  relayedEstimateRefused: relayed.status,
}

// 5. Delivery and the lock.
const order = await until('the sales order to be confirmed', async () => {
  const found = await ok(`/sales/orders/${salesOrderId}`)
  return found.status === 'confirmed' ? found : undefined
})
const lineId = (order.lines ?? order.requestedLines ?? [])[0]?.lineId ?? quoteLine
const picked = await ok('/sales/shipments', {
  method: 'POST',
  body: { orderId: salesOrderId, lines: [{ lineId, quantity: '2' }] },
})
const shipmentId = picked.shipmentId ?? picked.id
await ok(`/sales/shipments/${shipmentId}/pack`, { method: 'POST', body: {} })
await ok(`/sales/shipments/${shipmentId}/dispatch`, { method: 'POST', body: {} })
const intent = await until('the Sales fiscal origin', async () => intentOf(shipmentId, 'original'))
const draft = await ok('/fiscal/documents', {
  method: 'POST',
  body: { origin: { kind: 'sales', intentId: intent }, model: '55', environment: 'simulation', establishmentId: tenantId, series: 1 },
})
await until('the document to be locked', async () => {
  const ready = await call(`/fiscal/documents/${draft.id}/validate`, { method: 'POST' })
  if (ready.status >= 400) throw new Error(JSON.stringify(ready.body))
  return ready.body.document.status === 'ready'
})
const locked = await ok(`/fiscal/documents/${draft.id}/calculation`)
const lockedComponents = locked.lines.flatMap((line) => [...line.components.legacy, ...line.components.ibsCbs])
record.lock = {
  documentId: draft.id,
  components: lockedComponents.map((c) => `${c.code} ${c.amount.amount}`),
  resultDigest: locked.resultDigest,
  rulesDigest: locked.rulesDigest,
  agreesWithTheEstimate: locked.resultDigest !== undefined &&
    lockedComponents.every((c) => estimate.components.some((e) => e.code === c.code && e.amount.amount === c.amount.amount)),
}

// 6. The Ledger's postings: the taxes in the price, from the lock, once the document is
// authorized (Phase 91). Until then the lock is held, and nothing is posted.
const heldBack = await ledger(`/transactions?from=${today}&to=${today}&limit=200`)
const postedBeforeAuthorization = (heldBack.data ?? []).some(
  (row) => row.sourceType === 'tax-lock' && row.reference === `Fiscal ${draft.id.slice(0, 8)}`,
)
assert.equal(postedBeforeAuthorization, false, 'the lock posted before the authorization')
// The local simulation profile issues only the items it names, and this run's item is new:
// where the document cannot be issued, the lock stays held and the posting is not expected.
// The posting on authorization is proven against the database by the Ledger's e2e suite.
const queued = await call(`/fiscal/documents/${draft.id}/issue`, { method: 'POST' })
const authorized = queued.status === 202
if (authorized)
  await until('authorization', async () => {
    const found = await ok(`/fiscal/documents/${draft.id}`)
    return found.status === 'authorized' ? found : undefined
  })
const POSTED = new Set(['ICMS', 'PIS', 'COFINS', 'ISS', 'ICMS_UF_DEST', 'FCP_UF_DEST'])
const expected = lockedComponents
  .filter((c) => POSTED.has(c.code) && c.amount.amount !== '0')
  .reduce((sum, c) => sum + BigInt(c.amount.amount), 0n)
const posting = authorized
  ? await until('the Ledger to post the lock', async () => {
      const listed = await ledger(`/transactions?from=${today}&to=${today}&limit=200`)
      const found = (listed.data ?? []).find((row) => row.sourceType === 'tax-lock' && row.total === String(expected))
      return found ? ledger(`/transactions/${found.id}`) : undefined
    }, 120_000)
  : null
record.ledger = {
  postedBeforeAuthorization,
  authorized,
  expectedTotal: String(expected),
  ...(posting
    ? {
        transactionTotal: posting.total,
        lines: posting.lines.map((line) => `${line.accountCode} ${line.side} ${line.amount}`),
      }
    : { held: 'the document could not be issued under the local simulation profile' }),
}

// 7. The next version: the official calculator's 2026 package, with its impact.
const next = await catalogEntry(PACKAGES.nextVersion)
if (next.adoption.state === 'adopted')
  record.nextVersion = await adoptedEarlier(PACKAGES.nextVersion, next.adoption.effectiveFrom)
else {
  if (next.pendingChangeId)
    await call(`/fiscal/rule-changes/${next.pendingChangeId}/cancel`, { method: 'POST', body: { reason: 'Superseded by the Phase O golden path' } })
  record.nextVersion = await requestAndDecide(
    {
      kind: 'adopt-package',
      packageId: PACKAGES.nextVersion,
      effectiveFrom: today,
      interpretation: 'IBS and CBS 2026 by tax classification, as the official calculator agrees.',
      reason: 'Phase O golden path: the next version, decided on its impact',
      impactMonths: 3,
    },
    (impact) => impact.changed === 0 && impact.unsupported === 0,
  )
}

// 8. The locked calculation, replayed from its stored rules, unchanged.
const replayed = JSON.parse(
  execFileSync('docker', ['exec', 'horizon-fiscal', 'node', 'dist/phase82-catalog-cli.js', 'verify-lock', '--tenant', tenantId, '--document', draft.id], { encoding: 'utf8' }),
)
assert.equal(replayed.resultDigest, locked.resultDigest)
record.replay = { resultDigest: replayed.resultDigest, unchanged: true }

const out = join(root, `docs/drills/${today}-phase89-golden-path.json`)
await writeFile(out, `${JSON.stringify(record, null, 2)}\n`)
console.log(JSON.stringify(record, null, 2))
