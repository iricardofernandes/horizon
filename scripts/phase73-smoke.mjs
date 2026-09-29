#!/usr/bin/env node
/**
 * Phase 73 smoke, against the local stack through Kong (ADR 0066), in the demo workspace
 * (`make demo` first). It proves:
 *   1. an agent drafts a purchase requisition through its key;
 *   2. retrying the same MCP request creates nothing new;
 *   3. the key's issuer submits it and is refused approval with segregation-of-duties;
 *   4. another person approves it;
 *   5. Procurement's audit names the issuer and the key, and the agent log lists the draft;
 *   6. a read-only key is offered no draft tool and cannot write by name.
 * Agent access is left as it was found. Results go to docs/drills/; non-zero on failure.
 *
 *   node scripts/phase73-smoke.mjs [--base-url http://localhost:8000]
 */
import { randomUUID } from 'node:crypto'
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
const PASSWORD = 'Horizon-demo-2026!'
const startedAt = new Date()
const checks = []

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
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
  return { status: response.status, body: parsed }
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

async function signIn(email) {
  const selection = await ok('/auth/login', { method: 'POST', body: { email, password: PASSWORD } })
  const workspace = selection.workspaces.find((candidate) => candidate.slug === 'horizon-demo')
  if (!workspace) throw new Error(`${email} has no horizon-demo workspace`)
  const session = await ok('/auth/workspace', {
    method: 'POST',
    body: { selectionToken: selection.selectionToken, tenantId: workspace.tenantId },
  })
  return { tenantId: workspace.tenantId, token: session.accessToken }
}

let rpcId = 0
async function mcp(tenantId, secret, method, params = {}, id = undefined) {
  rpcId += 1
  return call(`/agent/tenants/${tenantId}/mcp`, {
    method: 'POST',
    token: secret,
    headers: { accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: id ?? rpcId, method, params },
  })
}

const resultOf = (answer) => {
  const text = answer.body?.result?.content?.[0]?.text ?? ''
  try {
    return JSON.parse(text).result
  } catch {
    return text
  }
}

async function run() {
  let operator = await signIn('demo@horizon.local')
  const { tenantId } = operator
  const me = await ok('/identity/me', { token: operator.token })
  const owner = await signIn('owner@horizon.local')
  const ownerMe = await ok('/identity/me', { token: owner.token })

  // A second person who may approve requisitions: the demo's owner.
  await call(`/identity/users/${ownerMe.id}/roles`, {
    method: 'POST',
    token: operator.token,
    body: { assignment: { module: 'procurement', role: 'approver' }, operation: 'grant' },
  })
  const approver = await signIn('owner@horizon.local')

  const previous = await ok('/agent/settings', { token: operator.token })
  await ok('/agent/settings', { method: 'PUT', token: operator.token, body: { enabled: true } })

  // What a requisition names: a warehouse and an item Procurement already knows.
  const [known] = (await ok('/procurement/requisitions?limit=1', { token: operator.token })).data ?? []
  if (!known) throw new Error('the demo workspace has no requisition to take a warehouse and item from')
  const detail = await ok(`/procurement/requisitions/${known.id}`, { token: operator.token })
  const warehouseId = detail.warehouseId ?? detail.requisition?.warehouseId
  const itemId = (Array.isArray(detail.data) ? detail.data : [])[0]?.itemId
  if (!warehouseId || !itemId) throw new Error(`no warehouse or item in ${JSON.stringify(detail)}`)

  const writerKey = await ok('/identity/api-keys', {
    method: 'POST',
    token: operator.token,
    body: { name: 'Phase 73 agent', scopes: ['agent:connect', 'procurement:write'] },
  })
  const readerKey = await ok('/identity/api-keys', {
    method: 'POST',
    token: operator.token,
    body: { name: 'Phase 73 reader', scopes: ['agent:connect', 'procurement:read'] },
  })

  try {
    // 1 and 2: a draft, and the same request again.
    const draft = {
      name: 'draft_purchase_requisition',
      arguments: {
        warehouseId,
        neededBy: '2026-12-31',
        justification: 'Phase 73 smoke: drafted by an agent',
        lines: [{ itemId, quantity: '2' }],
      },
    }
    const requestId = `phase73-${randomUUID()}`
    const first = await mcp(tenantId, writerKey.token, 'tools/call', draft, requestId)
    const created = resultOf(first)?.id
    check('an agent drafts a requisition through its key', typeof created === 'string' && !first.body?.result?.isError, first.body)
    const retried = await mcp(tenantId, writerKey.token, 'tools/call', draft, requestId)
    check('the same MCP request retried creates nothing new', resultOf(retried)?.id === created, resultOf(retried))

    // 3 and 4: the issuer submits, is refused approval, and somebody else approves.
    const drafted = await ok(`/procurement/requisitions/${created}`, { token: operator.token })
    const requestedBy = drafted.requestedBy ?? drafted.requisition?.requestedBy
    check('the draft counts as its issuer’s', requestedBy === me.id, { requestedBy, issuer: me.id })
    await ok(`/procurement/requisitions/${created}/submit`, { method: 'POST', token: operator.token })
    const refused = await call(`/procurement/requisitions/${created}/approve`, { method: 'POST', token: operator.token })
    check(
      'the issuer is refused approval of what their agent drafted',
      refused.status === 403 && JSON.stringify(refused.body).includes('segregation-of-duties'),
      refused.body,
    )
    const approved = await call(`/procurement/requisitions/${created}/approve`, { method: 'POST', token: approver.token })
    check('another person approves it', approved.status < 300, approved.body)

    // 5: both trails.
    const audit = await ok(`/procurement/audit?subjectId=${created}&action=requisition.opened`, { token: operator.token })
    const opened = audit.data?.[0]
    check(
      'Procurement’s audit names the issuer and the key',
      opened?.actor === me.id && opened?.details?.via === `api-key:${writerKey.apiKeyId}`,
      // What was compared, not the entry: a key id beside `api-key:` reads as a secret to scanners.
      { actorIsIssuer: opened?.actor === me.id, viaIsTheKey: opened?.details?.via === `api-key:${writerKey.apiKeyId}` },
    )
    const drafts = await ok('/agent/drafts?module=procurement&type=requisition', { token: operator.token })
    check('the agent log lists the draft for the requisitions screen', drafts.data.some((entry) => entry.recordId === created), drafts.data.slice(0, 3))

    // 6: a read-only key.
    const listed = await mcp(tenantId, readerKey.token, 'tools/list')
    const names = (listed.body?.result?.tools ?? []).map((tool) => tool.name)
    check('a read-only key is offered no draft tool', names.includes('list_requisitions') && !names.some((name) => name.startsWith('draft_')), names)
    const forced = await mcp(tenantId, readerKey.token, 'tools/call', draft)
    check('a read-only key cannot write by naming the tool', forced.body?.result?.isError === true, forced.body)
    return { tenantId, requisitionId: created }
  } finally {
    for (const key of [writerKey, readerKey])
      await call(`/identity/api-keys/${key.apiKeyId}`, { method: 'DELETE', token: operator.token })
    await call('/agent/settings', { method: 'PUT', token: operator.token, body: { enabled: previous.enabled } })
    await call(`/identity/users/${ownerMe.id}/roles`, {
      method: 'POST',
      token: operator.token,
      body: { assignment: { module: 'procurement', role: 'approver' }, operation: 'revoke' },
    })
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
  phase: 73,
  kind: 'agent-drafts-smoke',
  baseUrl,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  passed,
  ...(result ?? {}),
  checks,
}
const file = join(root, 'docs/drills', `${startedAt.toISOString().slice(0, 10)}-phase73-agent-drafts-smoke.json`)
await mkdir(dirname(file), { recursive: true })
await writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
console.log(`\n${passed ? 'passed' : 'FAILED'} — ${checks.length} checks, stored in ${file}`)
process.exit(passed ? 0 : 1)
