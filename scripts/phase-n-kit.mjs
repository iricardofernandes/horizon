/**
 * What the Phase N drill and golden path share (Phase 78): calls through Kong, new
 * workspaces and people, suppliers, attachments, keys and MCP calls, and a record of checks
 * that never holds a secret — no key, no token, no `api-key:` string.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const NOTICE = 'assistant-notice-v1'

export function flagOf(args, name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

export function kit({ baseUrl, label }) {
  const password = `${label}-${randomBytes(8).toString('hex')}`
  const checks = []

  async function call(path, { method = 'GET', body, token, raw, type, headers = {} } = {}) {
    const response = await fetch(path.startsWith('http') ? path : `${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'idempotency-key': randomUUID(),
        ...(raw ? { 'content-type': type } : body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(raw ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    let parsed = text
    try {
      parsed = JSON.parse(text)
    } catch {}
    return { status: response.status, body: parsed, headers: response.headers }
  }

  async function ok(path, options) {
    const answer = await call(path, options)
    if (answer.status >= 400)
      throw new Error(`${options?.method ?? 'GET'} ${path.split('?')[0]}: ${answer.status}`)
    return answer.body
  }

  async function until(what, probe, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await probe().catch(() => undefined)
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(`Timed out waiting for ${what}`)
  }

  function check(name, passed, detail) {
    checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) })
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

  // Kong allows /auth 30 times a minute per address: a sign-in is reused for three minutes,
  // well inside the recent-sign-in window that issuing a key asks for.
  const recent = new Map()
  async function signIn(email, tenantId, { fresh = false } = {}) {
    const cached = recent.get(`${email}|${tenantId}`)
    if (!fresh && cached && Date.now() - cached.at < 180_000) return cached.token
    const token = await freshSignIn(email, tenantId)
    recent.set(`${email}|${tenantId}`, { token, at: Date.now() })
    return token
  }

  async function freshSignIn(email, tenantId) {
    const selection = await ok('/auth/login', { method: 'POST', body: { email, password } })
    const session = await ok('/auth/workspace', {
      method: 'POST',
      body: { selectionToken: selection.selectionToken, tenantId },
    })
    return session.accessToken
  }

  /** A new workspace whose owner holds admin in the given modules. */
  async function workspace(name, modules) {
    const slug = `${label}-${name}-${randomBytes(3).toString('hex')}`
    const email = `owner.${slug}@horizon.local`
    const created = await ok('/auth/signup', {
      method: 'POST',
      body: { name: `${label} ${name}`, slug, timezone: 'America/Sao_Paulo', owner: { email, name: 'Drill Owner', password } },
    })
    const first = await signIn(email, created.tenantId, { fresh: true })
    for (const module of modules)
      await ok(`/identity/users/${created.ownerId}/roles`, {
        method: 'POST',
        token: first,
        body: { assignment: { module, role: 'admin' }, operation: 'grant' },
      })
    return {
      tenantId: created.tenantId,
      userId: created.ownerId,
      email,
      token: modules.length ? await signIn(email, created.tenantId, { fresh: true }) : first,
    }
  }

  /** Another person of the workspace, with the roles given, signed in. */
  async function person(owner, name, roles) {
    const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${randomBytes(3).toString('hex')}@horizon.local`
    const created = await ok('/identity/users', {
      method: 'POST',
      token: owner.token,
      body: { email, name, password, roles },
    })
    return { tenantId: owner.tenantId, userId: created.id ?? created.userId, email, token: await signIn(email, owner.tenantId) }
  }

  /** A new token, with the person's roles as they are now. */
  async function refresh(someone) {
    return { ...someone, token: await signIn(someone.email, someone.tenantId, { fresh: true }) }
  }

  async function grant(owner, userId, module, role, operation = 'grant') {
    await ok(`/identity/users/${userId}/roles`, {
      method: 'POST',
      token: owner.token,
      body: { assignment: { module, role }, operation },
    })
  }

  async function supplier(owner, name) {
    const party = await ok('/parties/parties', {
      method: 'POST',
      token: owner.token,
      body: {
        kind: 'organization',
        taxId: cnpj(),
        roles: ['supplier'],
        legalName: name,
        email: 'drill@example.com',
        phone: '1130000078',
        address: 'Rua do Exercício, 78, São Paulo',
      },
    })
    return party.id ?? party.partyId
  }

  /** A text file on a record, uploaded to its signed link and scanned available. */
  async function attach(owner, record, fileName, text) {
    const bytes = Buffer.from(text)
    const slot = await ok('/files/attachments', {
      method: 'POST',
      token: owner.token,
      body: { ...record, fileName, contentType: 'text/plain', size: bytes.length },
    })
    const uploaded = await call(slot.upload.url, { method: 'PUT', raw: bytes, type: 'text/plain' })
    if (uploaded.status !== 200) throw new Error(`upload ${uploaded.status}`)
    await until(`the scan of ${fileName}`, async () => {
      const current = await ok(`/files/attachments/${slot.attachment.id}`, { token: owner.token })
      return current.status === 'available' ? true : undefined
    })
    return slot.attachment.id
  }

  const search = (token, q, extra = '') => ok(`/knowledge/search?q=${encodeURIComponent(q)}${extra}`, { token })
  const ids = (answer) => (answer?.data ?? []).map((citation) => citation.attachmentId)

  /** A key and its secret; the secret stays in memory and never reaches the record. */
  async function issueKey(someone, name, scopes) {
    // Issuing a key takes a recent sign-in (step-up): sign in again first.
    const token = await signIn(someone.email, someone.tenantId)
    const key = await ok('/identity/api-keys', { method: 'POST', token, body: { name, scopes } })
    return { id: key.apiKeyId, secret: key.token, tenantId: someone.tenantId }
  }

  const exchange = (key, tenantId = key.tenantId) =>
    call('/auth/api-key/token', { method: 'POST', body: { tenantId, presented: key.secret } })

  let rpcId = 0
  async function mcp(key, method, params = {}, tenantId = key.tenantId) {
    rpcId += 1
    return call(`/agent/tenants/${tenantId}/mcp`, {
      method: 'POST',
      token: key.secret,
      headers: { accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: `${label}-${rpcId}`, method, params },
    })
  }

  /** A tool's answer: its parsed result, whether it was an error, and the HTTP status. */
  async function tool(key, name, args = {}, tenantId) {
    const answer = await mcp(key, 'tools/call', { name, arguments: args }, tenantId)
    const text = answer.body?.result?.content?.[0]?.text ?? ''
    let result
    try {
      result = JSON.parse(text).result
    } catch {
      result = undefined
    }
    return { status: answer.status, isError: answer.body?.result?.isError === true, text: text.slice(0, 160), result }
  }

  async function store(file, record) {
    const path = join(root, 'docs/drills', file)
    await mkdir(dirname(path), { recursive: true })
    const serialized = `${JSON.stringify(record, null, 2)}\n`
    // The record is published: nothing in it may read as a credential.
    if (/hz_[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10,}|api-key:/.test(serialized))
      throw new Error('the record would hold a secret; refusing to write it')
    await writeFile(path, serialized)
    return path
  }

  return {
    password,
    checks,
    call,
    ok,
    until,
    check,
    signIn,
    workspace,
    person,
    refresh,
    grant,
    supplier,
    attach,
    search,
    ids,
    issueKey,
    exchange,
    mcp,
    tool,
    store,
  }
}
