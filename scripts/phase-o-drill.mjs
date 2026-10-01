#!/usr/bin/env node
/**
 * Attacks Phase O through Kong and records what held (Phase 89), on the golden path
 * workspace. Only statuses, codes and booleans are stored: no token, key or secret.
 *
 *   node scripts/phase-o-drill.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1]
}
const tenantId = option('tenant', '01a0c5f8-798b-721e-912e-9b505406e614')
const otherTenant = '01a0b6b8-c334-7136-8144-e48a7ba17e08'
const baseUrl = option('base-url', 'http://localhost:8000').replace(/\/$/, '')
const mint = (tenant, ...roles) =>
  execFileSync(process.execPath, [join(root, 'infra/scripts/mint-dev-token.mjs'), '--tenant', tenant, '--sub', randomUUID(), ...roles.flatMap((role) => ['--role', role])], { encoding: 'utf8' }).trim()

const admin = mint(tenantId, 'fiscal:admin')
const otherAdmin = mint(tenantId, 'fiscal:admin')
const issuer = mint(tenantId, 'fiscal:issuer')
const viewer = mint(tenantId, 'fiscal:viewer')
const foreign = mint(otherTenant, 'fiscal:admin')

async function call(token, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}/fiscal${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  return { status: response.status, body: parsed }
}

const ownRule = (reason) => ({
  kind: 'add-rule',
  definition: {
    ruleKey: `drill.phase89.${Date.now()}`,
    version: 1,
    group: 'ibsCbs',
    code: 'CBS',
    precedence: 'operation',
    priority: 650,
    model: '55',
    environment: 'simulation',
    operation: 'rtc-v0057-model55-normal-sale',
    effectiveFrom: '2026-01-01',
    rate: { numerator: '12', denominator: '1000' },
    formula: 'LINE_NET_TIMES_RATE',
    sourceLocator: 'Phase 89 drill: never approved',
  },
  sourceBasis: { uri: 'https://example.invalid/phase89-drill', section: 'drill' },
  reason,
  impactMonths: 1,
})

const held = {}
const expectStatus = (name, result, expected, code) => {
  held[name] = {
    status: result.status,
    ...(result.body?.code ? { code: result.body.code } : {}),
    ...(result.body?.pair ? { pair: result.body.pair } : {}),
    held: result.status === expected && (!code || result.body?.code === code),
  }
}

// An override without a reason, through either door.
expectStatus('ruleChangeWithoutReason', await call(admin, '/rule-changes', { method: 'POST', body: ownRule('short') }), 400)
expectStatus(
  'overrideProposalWithoutReason',
  await call(admin, '/rule-overrides', {
    method: 'POST',
    body: { predecessorRuleId: randomUUID(), proposedDefinition: {}, sourceBasisUri: 'https://example.invalid', sourceBasisSection: 'x', reason: 'short' },
  }),
  400,
)
// A catalogue-level rule asked as a workspace's own.
expectStatus(
  'ownRuleAtDefaultPrecedence',
  await call(admin, '/rule-changes', {
    method: 'POST',
    body: { ...ownRule('The drill asks for a law-level rule'), definition: { ...ownRule('x').definition, precedence: 'default', operation: undefined } },
  }),
  400,
)
// Who may ask, who may decide.
expectStatus('issuerRequests', await call(issuer, '/rule-changes', { method: 'POST', body: ownRule('An issuer may not ask for a change') }), 403)
const request = await call(admin, '/rule-changes', { method: 'POST', body: ownRule('The drill asks, and nobody approves') })
held.requestRecorded = { status: request.status, held: request.status === 201 }
const changeId = request.body?.id
expectStatus('selfApproval', await call(admin, `/rule-changes/${changeId}/approve`, { method: 'POST', body: {} }), 403, 'segregation-of-duties')
expectStatus('selfRejection', await call(admin, `/rule-changes/${changeId}/reject`, { method: 'POST', body: {} }), 403, 'segregation-of-duties')
expectStatus('viewerApproves', await call(viewer, `/rule-changes/${changeId}/approve`, { method: 'POST', body: {} }), 403)
expectStatus('otherAdminCancels', await call(otherAdmin, `/rule-changes/${changeId}/cancel`, { method: 'POST', body: {} }), 403)
expectStatus('issuerLendsTheApproval', await call(issuer, '/delegations', {
  method: 'POST',
  body: { permission: 'fiscal:rules:approve', delegateId: 'drill', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() },
}), 403)
// Another workspace reads nothing of this one.
expectStatus('crossTenantRead', await call(foreign, `/rule-changes/${changeId}`), 404)
held.crossTenantList = {
  held: !((await call(foreign, '/rule-changes')).body?.data ?? []).some((entry) => entry.id === changeId),
}
expectStatus('requesterCancels', await call(admin, `/rule-changes/${changeId}/cancel`, { method: 'POST', body: { reason: 'Drill over' } }), 200)
// An unsupported scenario: an interstate sale nothing approved covers is refused, not guessed.
const capabilities = await call(admin, '/capabilities')
const outside = await call(admin, '/calculations/preview', {
  method: 'POST',
  body: {
    schemaVersion: 1,
    issuerEstablishmentId: capabilities.body?.supported?.[0]?.establishmentId ?? tenantId,
    model: '55',
    environment: 'simulation',
    operation: 'drill-unreviewed-operation',
    purpose: 'normal',
    issuer: { regime: 'normal', stateCode: '35', municipalityCode: '3550308' },
    recipient: { regime: 'normal', stateCode: '33', municipalityCode: '3304557', taxpayer: true },
    origin: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
    destination: { countryCode: '1058', stateCode: '33', municipalityCode: '3304557' },
    issueDate: '2026-10-01',
    currency: 'BRL',
    lines: [{ id: randomUUID(), itemId: randomUUID(), quantity: '1', unitPrice: '100', discount: { amount: '0', currency: 'BRL' }, charges: { amount: '0', currency: 'BRL' }, classifications: { ncm: '85094010' }, taxFacts: {} }],
  },
})
held.unreviewedScenario = { status: outside.status, code: outside.body?.code ?? null, held: outside.status >= 400 && Boolean(outside.body?.code) }
// The application cannot write the shared catalogue, whatever it is asked.
const write = execFileSync('docker', ['exec', 'horizon-fiscal', 'node', '-e', `
  const postgres = require('postgres')
  const sql = postgres(process.env.DATABASE_URL, { max: 1 })
  sql\`insert into fiscal_catalog_packages (id, authority, source_uri, package_digest, published_at, effective_from, source_bytes, publisher)
    values (gen_random_uuid(), 'forged', 'https://example.invalid', repeat('a', 64), '2026-01-01', '2026-01-01', '\\\\x00'::bytea, 'drill')\`
    .then(() => console.log('written'), (error) => console.log(error.code ?? 'refused'))
    .finally(() => sql.end())
`], { encoding: 'utf8' }).trim()
held.catalogueWriteByTheApplication = { outcome: write, held: write !== 'written' }

const record = { phase: 89, kind: 'phase-o-drill', ranAt: new Date().toISOString(), tenantId, held, allHeld: Object.values(held).every((entry) => entry.held) }
const day = new Date().toISOString().slice(0, 10)
await writeFile(join(root, `docs/drills/${day}-phase89-drill.json`), `${JSON.stringify(record, null, 2)}\n`)
console.log(JSON.stringify(record, null, 2))
if (!record.allHeld) process.exit(1)
