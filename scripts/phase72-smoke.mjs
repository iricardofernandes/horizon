#!/usr/bin/env node
/**
 * Phase 72 smoke, against the local stack through Kong (ADR 0065). It speaks JSON-RPC to the
 * tenant's MCP endpoint as an MCP client does, and proves:
 *   1. with agent access off, the endpoint refuses;
 *   2. an admitted key lists only the tools of its scopes and reads a real record;
 *   3. a tool outside the key's scopes is refused by name;
 *   4. a key without agent:connect, and a key sent to another workspace's URL, are refused;
 *   5. every call is audited without its arguments, the chain intact, and a key token
 *      cannot read the switch or the log;
 *   6. turning access off, or revoking the key, stops the agent at once.
 * It stores its results in docs/drills/, and exits non-zero if any check failed.
 *
 *   node scripts/phase72-smoke.mjs [--base-url http://localhost:8000]
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
const password = `phase72-${randomBytes(8).toString('hex')}`
const startedAt = new Date()
const checks = []
const timings = []

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  const started = performance.now()
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'idempotency-key': randomUUID(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed, ms: performance.now() - started }
}

async function ok(path, options) {
  const answer = await call(path, options)
  if (answer.status >= 400)
    throw new Error(`${options?.method ?? 'GET'} ${path}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return answer.body
}

function check(name, passed, detail) {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}${passed ? '' : ` — ${JSON.stringify(detail)}`}`)
}

function cnpj() {
  const base = Array.from({ length: 12 }, (_, index) =>
    index < 8 ? Math.floor(Math.random() * 10) : [0, 0, 0, 1][index - 8],
  )
  const digit = (digits) => {
    const weights =
      digits.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const rest = digits.reduce((sum, value, index) => sum + value * weights[index], 0) % 11
    return rest < 2 ? 0 : 11 - rest
  }
  const first = digit(base)
  return [...base, first, digit([...base, first])].join('')
}

async function workspace(label) {
  const slug = `phase72-${label}-${randomBytes(3).toString('hex')}`
  const email = `owner.${slug}@horizon.local`
  const created = await ok('/auth/signup', {
    method: 'POST',
    body: { name: `Phase 72 ${label}`, slug, timezone: 'America/Sao_Paulo', owner: { email, name: 'Smoke Owner', password } },
  })
  const selection = await ok('/auth/login', { method: 'POST', body: { email, password } })
  const session = await ok('/auth/workspace', {
    method: 'POST',
    body: { selectionToken: selection.selectionToken, tenantId: created.tenantId },
  })
  for (const module of ['parties', 'sales'])
    await ok(`/identity/users/${created.ownerId}/roles`, {
      method: 'POST',
      token: session.accessToken,
      body: { assignment: { module, role: 'admin' }, operation: 'grant' },
    })
  // A token carries the roles of its sign-in: sign in again to hold the ones just granted.
  const again = await ok('/auth/login', { method: 'POST', body: { email, password } })
  const fresh = await ok('/auth/workspace', {
    method: 'POST',
    body: { selectionToken: again.selectionToken, tenantId: created.tenantId },
  })
  return { tenantId: created.tenantId, ownerId: created.ownerId, token: fresh.accessToken }
}

async function issue(owner, name, scopes) {
  const created = await ok('/identity/api-keys', { method: 'POST', token: owner.token, body: { name, scopes } })
  return { id: created.apiKeyId, secret: created.token }
}

let rpcId = 0
async function mcp(tenantId, secret, method, params = {}) {
  rpcId += 1
  const answer = await call(`/agent/tenants/${tenantId}/mcp`, {
    method: 'POST',
    token: secret,
    headers: { accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: rpcId, method, params },
  })
  timings.push(answer.ms)
  return answer
}

const initialize = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'phase72-smoke', version: '1.0.0' },
}

async function run() {
  const owner = await workspace('a')
  const stranger = await workspace('b')
  const marker = `Agente ${randomBytes(3).toString('hex')}`
  const party = await ok('/parties/parties', {
    method: 'POST',
    token: owner.token,
    body: {
      kind: 'organization',
      taxId: cnpj(),
      roles: ['customer'],
      legalName: `${marker} LTDA`,
      email: 'compras@agente.example',
      phone: '1130000072',
      address: 'Rua do Agente, 72, São Paulo',
    },
  })
  const partyId = party.id ?? party.partyId
  const agentKey = await issue(owner, 'Agent', ['agent:connect', 'parties:read'])
  const noConnect = await issue(owner, 'No connect', ['parties:read'])

  // 1. Off by default.
  const off = await mcp(owner.tenantId, agentKey.secret, 'initialize', initialize)
  check('with access off, the endpoint refuses', off.status === 403 && off.body?.type?.endsWith('/agent-access-off'), off.body)

  await ok('/agent/settings', { method: 'PUT', token: owner.token, body: { enabled: true } })
  await ok('/agent/settings', { method: 'PUT', token: stranger.token, body: { enabled: true } })

  // 2. Admitted: the tools of its scopes, and a real read.
  const initialized = await mcp(owner.tenantId, agentKey.secret, 'initialize', initialize)
  check('an admitted key initializes', initialized.status === 200 && initialized.body?.result?.serverInfo?.name === 'horizon-agent', initialized.body)
  const listed = await mcp(owner.tenantId, agentKey.secret, 'tools/list')
  const names = (listed.body?.result?.tools ?? []).map((tool) => tool.name).sort()
  check('it lists only the tools its scopes reach', JSON.stringify(names) === '["get_party","list_parties"]', names)
  const parties = await mcp(owner.tenantId, agentKey.secret, 'tools/call', {
    name: 'list_parties',
    arguments: { search: marker },
  })
  const partiesText = parties.body?.result?.content?.[0]?.text ?? ''
  check('it reads a real record through its key', partiesText.includes(marker) && !parties.body?.result?.isError, parties.body)
  const one = await mcp(owner.tenantId, agentKey.secret, 'tools/call', { name: 'get_party', arguments: { id: partyId } })
  check('it reads one record by id', (one.body?.result?.content?.[0]?.text ?? '').includes(partyId), one.body)

  // 3. A tool outside its scopes, asked for by name.
  const sales = await mcp(owner.tenantId, agentKey.secret, 'tools/call', { name: 'list_sales_orders', arguments: {} })
  check('a tool outside its scopes is refused by name', Boolean(sales.body?.result?.isError || sales.body?.error), sales.body)

  // 4. Without agent:connect; and on another workspace's URL.
  const missing = await mcp(owner.tenantId, noConnect.secret, 'initialize', initialize)
  check('a key without agent:connect is refused', missing.status === 403 && missing.body?.type?.endsWith('/agent-connect-missing'), missing.body)
  const forged = await mcp(stranger.tenantId, agentKey.secret, 'tools/call', { name: 'list_parties', arguments: {} })
  check('a key sent to another workspace URL gets 401 and no data', forged.status === 401 && !JSON.stringify(forged.body).includes(marker), forged.body)

  // 5. The audit, and what a key token cannot reach.
  const audit = await ok('/agent/audit?action=agent.tool.called&limit=50', { token: owner.token })
  const calls = audit.data.filter((entry) => entry.actor === `api-key:${agentKey.id}`)
  check('every call is audited under its key, with the chain intact', calls.length === 3 && audit.chain.status === 'intact', { calls: calls.length, chain: audit.chain })
  check('the audit keeps no argument and no answer', !JSON.stringify(audit).includes(marker), null)
  const readerKey = await issue(owner, 'Identity reader', ['identity:read'])
  const exchanged = await ok('/auth/api-key/token', { method: 'POST', body: { tenantId: owner.tenantId, presented: readerKey.secret } })
  const keySettings = await call('/agent/settings', { token: exchanged.accessToken })
  const keyAudit = await call('/agent/audit', { token: exchanged.accessToken })
  check('a key token cannot read the switch or the log', keySettings.status === 403 && keyAudit.status === 403, { settings: keySettings.status, audit: keyAudit.status })
  const strangerAudit = await ok('/agent/audit?limit=50', { token: stranger.token })
  check('another workspace sees none of these calls', !strangerAudit.data.some((entry) => entry.actor === `api-key:${agentKey.id}`), strangerAudit.data.length)

  // 6. Off again, then revoked.
  await ok('/agent/settings', { method: 'PUT', token: owner.token, body: { enabled: false } })
  const switchedOff = await mcp(owner.tenantId, agentKey.secret, 'tools/list')
  check('turning access off stops the agent at once', switchedOff.status === 403, switchedOff.body)
  await ok('/agent/settings', { method: 'PUT', token: owner.token, body: { enabled: true } })
  await call(`/identity/api-keys/${agentKey.id}`, { method: 'DELETE', token: owner.token })
  const revoked = await mcp(owner.tenantId, agentKey.secret, 'tools/list')
  check('a revoked key is refused at once', revoked.status === 401, revoked.body)

  const admitted = timings.filter((ms) => ms > 0).sort((a, b) => a - b)
  return {
    tenantId: owner.tenantId,
    tools: names,
    mcpRequestMs: {
      count: admitted.length,
      median: Math.round(admitted[Math.floor(admitted.length / 2)] ?? 0),
      max: Math.round(admitted.at(-1) ?? 0),
    },
  }
}

let result
try {
  result = await run()
} catch (error) {
  check('the smoke ran to the end', false, String(error))
}
const passed = checks.every((entry) => entry.passed)
const record = {
  phase: 72,
  kind: 'agent-mcp-smoke',
  baseUrl,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  passed,
  ...(result ?? {}),
  checks,
}
const file = join(root, 'docs/drills', `${startedAt.toISOString().slice(0, 10)}-phase72-agent-smoke.json`)
await mkdir(dirname(file), { recursive: true })
await writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
console.log(`\n${passed ? 'passed' : 'FAILED'} — ${checks.length} checks, stored in ${file}`)
process.exit(passed ? 0 : 1)
