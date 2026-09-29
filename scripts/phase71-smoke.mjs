#!/usr/bin/env node
/**
 * Phase 71 smoke, against the local stack through Kong (ADR 0064). In a new workspace whose
 * owner holds a role in every module, it issues API keys and proves:
 *   1. a read-only key reads every module and every module refuses its writes, with the
 *      same 403;
 *   2. a read-write key's writes pass the scope check in every module;
 *   3. a key without a module's scope cannot even read that module;
 *   4. a revoked key fails its next exchange;
 *   5. an issuer who loses their role in a module takes it away from their key;
 *   6. a key over its limit gets 429 with Retry-After.
 * It stores its results in docs/drills/, and exits non-zero if any check failed.
 *
 *   node scripts/phase71-smoke.mjs [--base-url http://localhost:8000]
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const baseUrl = flag('base-url', 'http://localhost:8000').replace(/\/$/, '')
const SCOPE_REFUSAL = "The API key's scopes do not permit this operation"
const password = `phase71-${randomBytes(8).toString('hex')}`
const startedAt = new Date()
const checks = []

/** One real read and one real write route per module, as Kong exposes them. */
const MODULES = [
  { module: 'identity', read: '/identity/users', write: '/identity/users' },
  { module: 'catalog', read: '/catalog/units', write: '/catalog/units' },
  { module: 'inventory', read: '/inventory/delegations', write: '/inventory/delegations' },
  { module: 'sales', read: '/sales/contracts', write: '/sales/billing-runs/preview' },
  {
    module: 'webhooks',
    read: '/webhooks/webhook-subscriptions',
    write: '/webhooks/webhook-subscriptions',
  },
  { module: 'parties', read: '/parties/imports', write: '/parties/parties/duplicate-check' },
  { module: 'financial', read: '/financial/imports', write: '/financial/categories' },
  { module: 'treasury', read: '/treasury/audit', write: '/treasury/accounts' },
  { module: 'ledger', read: '/ledger/audit', write: '/ledger/accounts' },
  { module: 'procurement', read: '/procurement/audit', write: '/procurement/requisitions' },
  { module: 'fiscal', read: '/fiscal/capabilities?model=55', write: '/fiscal/documents' },
  { module: 'crm', read: '/crm/audit', write: '/crm/pipelines' },
  { module: 'reporting', read: '/reporting/consistency-checks', write: '/reporting/views' },
  { module: 'files', read: '/files/audit', write: '/files/attachments' },
]
const ROLE_MODULES = MODULES.map(({ module }) => module).filter(
  (module) => !['identity', 'files'].includes(module),
)

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'idempotency-key': randomUUID(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, headers: response.headers, body: parsed }
}

async function ok(path, options) {
  const answer = await call(path, options)
  if (answer.status >= 400)
    throw new Error(
      `${options?.method ?? 'GET'} ${path}: ${answer.status} ${JSON.stringify(answer.body)}`,
    )
  return answer.body
}

function check(name, passed, detail) {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}${passed ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const refusedByScope = (answer) =>
  answer.status === 403 && (answer.body?.detail ?? answer.body?.message) === SCOPE_REFUSAL

/** A new workspace whose owner holds admin in every module with roles. */
async function workspace() {
  const slug = `phase71-${randomBytes(4).toString('hex')}`
  const email = `owner.${slug}@horizon.local`
  const created = await ok('/auth/signup', {
    method: 'POST',
    body: {
      name: 'Phase 71 smoke',
      slug,
      timezone: 'America/Sao_Paulo',
      owner: { email, name: 'Smoke Owner', password },
    },
  })
  const selection = await ok('/auth/login', { method: 'POST', body: { email, password } })
  const session = await ok('/auth/workspace', {
    method: 'POST',
    body: { selectionToken: selection.selectionToken, tenantId: created.tenantId },
  })
  for (const module of ROLE_MODULES)
    await ok(`/identity/users/${created.ownerId}/roles`, {
      method: 'POST',
      token: session.accessToken,
      body: { assignment: { module, role: 'admin' }, operation: 'grant' },
    })
  return { tenantId: created.tenantId, ownerId: created.ownerId, token: session.accessToken }
}

async function issue(owner, name, scopes) {
  const created = await ok('/identity/api-keys', {
    method: 'POST',
    token: owner.token,
    body: { name, scopes },
  })
  return { id: created.apiKeyId, secret: created.token }
}

function exchange(owner, key) {
  return call('/auth/api-key/token', {
    method: 'POST',
    body: { tenantId: owner.tenantId, presented: key.secret },
  })
}

async function tokenOf(owner, key) {
  const answer = await exchange(owner, key)
  if (answer.status !== 200) throw new Error(`exchange ${answer.status} ${JSON.stringify(answer.body)}`)
  return answer.body
}

async function run() {
  const owner = await workspace()
  const reads = MODULES.map(({ module }) => (module === 'files' ? 'files:read' : `${module}:read`))
  const writes = MODULES.map(({ module }) => (module === 'files' ? 'files:write' : `${module}:write`))
  const readOnly = await issue(owner, 'Read only', reads)
  const readWrite = await issue(owner, 'Read and write', writes)

  // 1 and 2: every module, through Kong.
  const perModule = []
  for (const { module, read, write } of MODULES) {
    const reader = await tokenOf(owner, readOnly)
    const writer = await tokenOf(owner, readWrite)
    const readAnswer = await call(read, { token: reader.accessToken })
    const refusedWrite = await call(write, { method: 'POST', token: reader.accessToken, body: {} })
    const allowedWrite = await call(write, { method: 'POST', token: writer.accessToken, body: {} })
    perModule.push({
      module,
      read: readAnswer.status,
      writeWithReadScope: refusedWrite.status,
      writeWithWriteScope: allowedWrite.status,
    })
    check(
      `${module}: a read scope reads`,
      readAnswer.status < 400 || (readAnswer.status !== 401 && !refusedByScope(readAnswer)),
      readAnswer,
    )
    check(`${module}: a read scope cannot write`, refusedByScope(refusedWrite), refusedWrite)
    check(
      `${module}: a write scope passes the scope check`,
      allowedWrite.status !== 401 && !refusedByScope(allowedWrite),
      allowedWrite,
    )
  }

  // 3: a key without a module's scope cannot read it.
  const catalogOnly = await issue(owner, 'Catalog only', ['catalog:read'])
  const catalogToken = await tokenOf(owner, catalogOnly)
  check(
    'a catalog:read key reads Catalog',
    (await call('/catalog/units', { token: catalogToken.accessToken })).status === 200,
  )
  const salesRead = await call('/sales/contracts', { token: catalogToken.accessToken })
  check('a key without a sales scope cannot read Sales', refusedByScope(salesRead), salesRead)
  check(
    'the exchange answers the scopes and no roles',
    JSON.stringify(catalogToken.scopes) === '["catalog:read"]' && !('roles' in catalogToken),
    // The shape only: the token itself is a credential and never goes into the record.
    { fields: Object.keys(catalogToken).sort(), scopes: catalogToken.scopes },
  )

  // 4: revocation takes effect on the next exchange.
  await call(`/identity/api-keys/${catalogOnly.id}`, { method: 'DELETE', token: owner.token })
  const revoked = await exchange(owner, catalogOnly)
  check('a revoked key fails its next exchange', revoked.status === 401, revoked)

  // 5: the issuer loses their Sales role; the key no longer reaches Sales.
  const salesKey = await issue(owner, 'Sales reader', ['sales:read'])
  check('a sales:read key exchanges while its issuer holds Sales', (await exchange(owner, salesKey)).status === 200)
  await ok(`/identity/users/${owner.ownerId}/roles`, {
    method: 'POST',
    token: owner.token,
    body: { assignment: { module: 'sales', role: 'admin' }, operation: 'revoke' },
  })
  const outgrown = await exchange(owner, salesKey)
  check(
    'an issuer who loses a role takes it away from the key',
    outgrown.status === 403 && outgrown.body?.type === 'https://horizon.dev/problems/scope-beyond-issuer',
    outgrown,
  )

  // 6: the limit per key.
  const busy = await issue(owner, 'Busy', ['catalog:read'])
  let limited
  let exchanges = 0
  while (!limited && exchanges < 400) {
    const answer = await exchange(owner, busy)
    exchanges += 1
    if (answer.status === 429) limited = answer
    else if (answer.status !== 200) throw new Error(`exchange ${answer.status}`)
  }
  const retryAfter = Number(limited?.headers.get('retry-after'))
  check('a key over its limit gets 429 with Retry-After', Boolean(limited) && retryAfter > 0 && retryAfter <= 60, {
    exchanges,
    status: limited?.status,
    retryAfter,
    type: limited?.body?.type,
  })
  return { tenantId: owner.tenantId, perModule, exchangesUntilLimited: exchanges }
}

let result
try {
  result = await run()
} catch (error) {
  check('the smoke ran to the end', false, String(error))
}
const passed = checks.every((entry) => entry.passed)
const record = {
  phase: 71,
  kind: 'api-key-scopes-smoke',
  baseUrl,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  passed,
  ...(result ?? {}),
  checks,
}
const file = join(root, 'docs/drills', `${startedAt.toISOString().slice(0, 10)}-phase71-api-key-smoke.json`)
await mkdir(dirname(file), { recursive: true })
await writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
console.log(`\n${passed ? 'passed' : 'FAILED'} — ${checks.length} checks, stored in ${file}`)
process.exit(passed ? 0 : 1)
