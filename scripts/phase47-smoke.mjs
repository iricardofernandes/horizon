#!/usr/bin/env node
/**
 * Phase 47 local-stack smoke through Kong. A reviewed Catalog service, provided by the
 * issuer in São Paulo to a company, becomes a national NFS-e in simulation:
 * - the municipal registry routes São Paulo to the national system and refuses Campinas;
 * - one contract-period source key maps to one service origin;
 * - the DPS is generated into an NFS-e (with a lost first response, when the local
 *   simulator runs `timeout-after-accept`);
 * - the NFS-e is substituted (event 105102) and the substitute is cancelled (101101).
 * Nothing posts stock or money.
 *
 *   node scripts/phase47-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
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
    ...['parties:admin', 'catalog:admin', 'identity:admin', 'fiscal:admin'].flatMap((role) => [
      '--role',
      role,
    ]),
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

function sql(database, statement) {
  return execFileSync(
    'docker',
    ['exec', postgresContainer, 'psql', '-U', 'postgres', '-d', database, '-At', '-c', statement],
    { encoding: 'utf8' },
  ).trim()
}

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

const today = new Date().toISOString().slice(0, 10)
const competenceDate = `${today.slice(0, 7)}-01`
const evidence = { checkedAt: new Date().toISOString(), tenantId, competenceDate }

// --- the municipality decides --------------------------------------------------------------
const kinds = await ok('/fiscal/document-kinds')
assert.deepEqual(kinds.eventFlows.find((entry) => entry.model === 'nfse').flows, ['cancellation'])
const saoPaulo = await ok(`/fiscal/nfse-registry/municipalities/3550308?competenceDate=${competenceDate}`)
assert.equal(saoPaulo.route, 'national', JSON.stringify(saoPaulo))
const campinas = await ok(`/fiscal/nfse-registry/municipalities/3509502?competenceDate=${competenceDate}`)
assert.equal(campinas.route, 'unsupported')
assert.match(campinas.reason, /E0039/)
evidence.registry = {
  versionId: saoPaulo.versionId,
  saoPaulo: saoPaulo.entry.sourceLocator,
  campinas: campinas.reason,
}

// --- a reviewed service -------------------------------------------------------------------
const workspace = await ok('/identity/workspace')
assert.equal(workspace.company.address.municipalityCode, '3550308')
const [unit] = (await ok('/catalog/units')).data
const service = await ok('/catalog/items', {
  method: 'POST',
  body: { kind: 'service', sku: `DEV-${Date.now()}`, name: 'Desenvolvimento de sistemas sob medida', unitId: unit.id },
})
const serviceItemId = service.id ?? service.itemId
const profile = await until('the service profile (Catalog item visible to Fiscal)', async () => {
  const saved = await call('/fiscal/service-profiles', {
    method: 'POST',
    body: {
      itemId: serviceItemId,
      nationalTaxCode: '010101',
      nbsCode: '115022000',
      issTaxation: '1',
      description: 'Análise e desenvolvimento de sistemas',
      effectiveFrom: '2026-01-01',
      reason: 'Classificação revisada no smoke da fase 47',
    },
  })
  if (saved.status >= 400) throw new Error(JSON.stringify(saved.body))
  return saved.body
})
assert.equal(profile.revision, 1)

const taxId = cnpj()
const party = await ok('/parties/parties', {
  method: 'POST',
  body: {
    kind: 'organization',
    taxId,
    roles: ['customer'],
    legalName: 'Cliente de Serviços Smoke Fase 47 LTDA',
    email: `servicos-${Date.now()}@example.com`,
    phone: '11999990000',
    address: 'Avenida Paulista, 1000, São Paulo',
  },
})
const recipientId = party.id ?? party.partyId
const { revision: recipientRevision } = await ok(`/parties/parties/${recipientId}/fiscal-profile`, {
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

const originBody = (amount, sourceKey) => ({
  establishmentId: tenantId,
  issuerProfileRevision: workspace.fiscalProfileRevision,
  recipientPartyId: recipientId,
  recipientProfileRevision: recipientRevision,
  serviceItemId,
  serviceProfileRevision: profile.revision,
  competenceDate,
  amount: { amount, currency: 'BRL' },
  description: 'Desenvolvimento de sistema sob medida (smoke da fase 47)',
  reason: 'Serviço prestado e revisado no smoke da fase 47',
  ...(sourceKey ? { sourceKey } : {}),
})
const sourceKey = { module: 'contracts', documentType: 'contract-period', id: randomUUID(), period: competenceDate.slice(0, 7) }
const origin = await until('the recipient projection in Fiscal', async () => {
  const created = await call('/fiscal/service-origins', { method: 'POST', body: originBody('150000', sourceKey) })
  if (created.status >= 400) throw new Error(JSON.stringify(created.body))
  return created
})
assert.equal(origin.status, 201)
const replayed = await ok('/fiscal/service-origins', { method: 'POST', body: originBody('150000', sourceKey) })
assert.equal(replayed.id, origin.body.id)
assert.equal(replayed.existing, true)
const conflicting = await call('/fiscal/service-origins', { method: 'POST', body: originBody('999900', sourceKey) })
assert.equal(conflicting.status, 409)
assert.equal(conflicting.body.code, 'SOURCE_KEY_CONFLICT')
evidence.origin = { id: origin.body.id, sourceKey: 'contracts/contract-period', replayExisting: true, conflict: conflicting.body.code }

async function issued(serviceOriginId, create) {
  const draft = await create()
  const ready = await call(`/fiscal/service-documents/${draft.id}/validate`, { method: 'POST' })
  assert.equal(ready.status, 200, JSON.stringify(ready.body))
  const queued = await call(`/fiscal/service-documents/${draft.id}/issue`, { method: 'POST' })
  assert.equal(queued.status, 202, JSON.stringify(queued.body))
  return until('NFS-e generation', async () => {
    const found = await ok(`/fiscal/service-documents/${draft.id}`)
    if (found.status === 'rejected') throw new Error(`NFS-e rejected: ${serviceOriginId}`)
    return found.status === 'authorized' ? found : undefined
  })
}

async function artifact(documentId, kind) {
  const listed = await ok(`/fiscal/documents/${documentId}/artifacts`)
  const entry = listed.artifacts.filter((row) => row.kind === kind).at(-1)
  assert.ok(entry, `${kind} is missing`)
  const response = await fetch(`${baseUrl}/fiscal/documents/${documentId}/artifacts/${kind}?digest=${entry.digest}`, {
    headers: { authorization: `Bearer ${operator}` },
  })
  assert.equal(response.status, 200)
  return Buffer.from(await response.arrayBuffer()).toString('utf8')
}

// --- the DPS becomes an NFS-e --------------------------------------------------------------
const nfse = await issued(origin.body.id, () =>
  ok('/fiscal/service-documents', {
    method: 'POST',
    body: { serviceOriginId: origin.body.id, environment: 'simulation', establishmentId: tenantId, series: 1 },
  }),
)
assert.equal(nfse.municipalityCode, '3550308')
assert.match(nfse.dpsId, new RegExp(`^DPS35503082${workspace.company.taxId}00001`))
assert.equal(nfse.nfseKey.slice(0, 7), '3550308')
const nfseXml = await artifact(nfse.id, 'nfse_xml')
for (const fragment of ['<cTribNac>010101</cTribNac>', '<cNBS>115022000</cNBS>', '<pAliqAplic>2.00</pAliqAplic>', '<vISSQN>30.00</vISSQN>', `<CNPJ>${taxId}</CNPJ>`, '<cStat>100</cStat>'])
  assert.ok(nfseXml.includes(fragment), `NFS-e XML lacks ${fragment}`)
const dps = await artifact(nfse.id, 'signed_xml')
assert.ok(!dps.includes('<pAliq>'), 'A non-Simples DPS must not state the ISS rate (E0617)')
const explanation = await ok(`/fiscal/documents/${nfse.id}/calculation/explanation`)
assert.ok(explanation.sources.some((source) => source.uri.includes('parametros_municipais/3550308')))
assert.ok(explanation.sources.some((source) => source.uri.includes('calculadora')))
const observations = sql(
  'horizon_fiscal',
  `select string_agg(observation.observation_kind || ':' || observation.outcome, ',' order by observation.observed_at)
   from fiscal_dispatch_observations observation join fiscal_dispatch_commands command
     on command.tenant_id = observation.tenant_id and command.id = observation.command_id
   where command.document_id = '${nfse.id}'`,
)
evidence.nfse = {
  documentId: nfse.id,
  number: nfse.number,
  dpsId: nfse.dpsId.replace(workspace.company.taxId, '<cnpj>'),
  nfseNumber: nfse.nfseNumber,
  observations,
  sources: explanation.sources.map((source) => source.section),
}

// --- substitution (event 105102) -----------------------------------------------------------
const corrected = await ok('/fiscal/service-origins', { method: 'POST', body: originBody('120000') })
const substitute = await issued(corrected.id, () =>
  ok(`/fiscal/service-documents/${nfse.id}/substitutions`, {
    method: 'POST',
    body: {
      reasonCode: '99',
      reason: 'Valor do serviço revisado com o cliente no smoke',
      correctedOrigin: { serviceOriginId: corrected.id },
    },
  }),
)
assert.equal(substitute.substitutesDocumentId, nfse.id)
const replaced = await ok(`/fiscal/service-documents/${nfse.id}`)
assert.equal(replaced.status, 'cancelled')
assert.equal(replaced.substitutedByDocumentId, substitute.id)
assert.ok((await artifact(substitute.id, 'signed_xml')).includes(`<chSubstda>${nfse.nfseKey}</chSubstda>`))
assert.ok((await artifact(substitute.id, 'substitution_event')).includes('<e105102>'))
evidence.substitution = { documentId: substitute.id, number: substitute.number, original: replaced.status }

// --- cancellation (event 101101) -----------------------------------------------------------
const cancellation = await call(`/fiscal/service-documents/${substitute.id}/cancellation-requests`, {
  method: 'POST',
  body: { reasonCode: '1', reason: 'Erro na emissão apontado no smoke da fase 47' },
})
assert.equal(cancellation.status, 202, JSON.stringify(cancellation.body))
await until('NFS-e cancellation', async () => (await ok(`/fiscal/service-documents/${substitute.id}`)).status === 'cancelled')
assert.ok((await artifact(substitute.id, 'cancellation_protocol')).includes('<e101101>'))

// --- events: fiscal facts only, delivered ---------------------------------------------------
const events = sql(
  'horizon_fiscal',
  `select string_agg(payload->>'outcome' || ':' || (delivered_at is not null)::text, ',' order by created_at)
   from fiscal_outbox where tenant_id = '${tenantId}'
     and event_type = 'fiscal.service-document.simulation-outcome'
     and payload->>'documentId' in ('${nfse.id}', '${substitute.id}')`,
)
evidence.events = events
const counted = events.split(',')
assert.equal(counted.length, 4, events)
evidence.result = 'passed'
console.log(JSON.stringify(evidence, null, 2))
