#!/usr/bin/env node
/**
 * Phase 75 smoke, against the local stack through Kong (ADR 0067). In two new workspaces it
 * proves:
 *   1. a search finds a party's contract and a payable's invoice, each cited;
 *   2. a key without Financial never gets the invoice, answered exactly as nonsense is;
 *   3. the agent's search_documents answers with the same scopes;
 *   4. a canary in another workspace never appears, whatever is asked;
 *   5. erasing the party takes its contract out of search.
 * Keys are revoked and agent access restored. Results go to docs/drills/; non-zero on failure.
 *
 *   node scripts/phase75-smoke.mjs [--base-url http://localhost:8000]
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
const password = `phase75-${randomBytes(8).toString('hex')}`
const startedAt = new Date()
const checks = []

async function call(path, { method = 'GET', body, token, raw, type, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
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
  return { status: response.status, body: parsed }
}

async function ok(path, options) {
  const answer = await call(path, options)
  if (answer.status >= 400)
    throw new Error(`${options?.method ?? 'GET'} ${path}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return answer.body
}

async function until(label, probe, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined)
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for ${label}`)
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

async function signIn(email, tenantId) {
  const selection = await ok('/auth/login', { method: 'POST', body: { email, password } })
  const session = await ok('/auth/workspace', {
    method: 'POST',
    body: { selectionToken: selection.selectionToken, tenantId },
  })
  return session.accessToken
}

/** A new workspace whose owner reads and writes parties and financial. */
async function workspace(label) {
  const slug = `phase75-${label}-${randomBytes(3).toString('hex')}`
  const email = `owner.${slug}@horizon.local`
  const created = await ok('/auth/signup', {
    method: 'POST',
    body: { name: `Phase 75 ${label}`, slug, timezone: 'America/Sao_Paulo', owner: { email, name: 'Smoke Owner', password } },
  })
  const first = await signIn(email, created.tenantId)
  for (const module of ['parties', 'financial'])
    await ok(`/identity/users/${created.ownerId}/roles`, {
      method: 'POST',
      token: first,
      body: { assignment: { module, role: 'admin' }, operation: 'grant' },
    })
  return { tenantId: created.tenantId, token: await signIn(email, created.tenantId) }
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
      email: 'busca@example.com',
      phone: '1130000075',
      address: 'Rua da Busca, 75, São Paulo',
    },
  })
  return party.id ?? party.partyId
}

/** A text file on a record: a slot, the bytes to its signed link, and the scan's answer. */
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
    return current.status === 'available' ? current : undefined
  })
  return slot.attachment.id
}

const search = (token, q, extra = '') =>
  ok(`/knowledge/search?q=${encodeURIComponent(q)}${extra}`, { token })
const ids = (answer) => answer.data.map((citation) => citation.attachmentId)

async function keyToken(owner, name, scopes) {
  const key = await ok('/identity/api-keys', { method: 'POST', token: owner.token, body: { name, scopes } })
  const exchanged = await ok('/auth/api-key/token', {
    method: 'POST',
    body: { tenantId: owner.tenantId, presented: key.token },
  })
  return { id: key.apiKeyId, secret: key.token, token: exchanged.accessToken }
}

let rpcId = 0
async function tool(tenantId, secret, name, args) {
  rpcId += 1
  const answer = await call(`/agent/tenants/${tenantId}/mcp`, {
    method: 'POST',
    token: secret,
    headers: { accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } },
  })
  const text = answer.body?.result?.content?.[0]?.text ?? ''
  try {
    return JSON.parse(text).result
  } catch {
    return { error: text }
  }
}

async function run() {
  const owner = await workspace('a')
  const partyId = await supplier(owner, 'Torrefação Busca Fase 75 LTDA')
  const today = new Date().toISOString().slice(0, 10)
  const payable = await until('the supplier in Financial', async () => {
    const drafted = await call('/financial/payables', {
      method: 'POST',
      token: owner.token,
      body: { partyId, documentNumber: `NF-75-${randomBytes(3).toString('hex')}`, currency: 'BRL', issuedOn: today, installments: [{ dueOn: today, amount: '150000' }] },
    })
    return drafted.status < 300 ? drafted.body : undefined
  })
  const invoiceMarker = `gerador${randomBytes(3).toString('hex')}`
  const contract = await attach(
    owner,
    { module: 'parties', recordType: 'party', recordId: partyId },
    'contrato.txt',
    'Contrato de fornecimento de café torrado, com entregas mensais em Campinas e pagamento em 30 dias.',
  )
  const invoice = await attach(
    owner,
    { module: 'financial', recordType: 'payable', recordId: payable.id },
    'fatura.txt',
    `Fatura de manutenção do ${invoiceMarker}: troca de óleo e bateria da unidade de Sorocaba.`,
  )
  const invoiceQuestion = `fatura manutenção ${invoiceMarker}`
  await until('both files to be searchable', async () =>
    ids(await search(owner.token, 'fornecimento de café')).includes(contract) &&
    ids(await search(owner.token, invoiceQuestion)).includes(invoice)
      ? true
      : undefined,
  )

  // 1. The owner finds both, each cited.
  const [coffee] = (await search(owner.token, 'fornecimento de café')).data
  check(
    'a search finds the party’s contract and cites its attachment, record, screen, position and text',
    coffee?.attachmentId === contract &&
      coffee.record.module === 'parties' &&
      coffee.record.recordId === partyId &&
      coffee.screen === '/app/registrations/parties' &&
      coffee.position.chunk === 1 &&
      coffee.excerpt.includes('café torrado'),
    coffee,
  )
  const [bill] = (await search(owner.token, invoiceQuestion)).data
  check(
    'a payable’s invoice is cited with the screen that opens the payable',
    bill?.attachmentId === invoice && bill.screen === `/app/finance/payables?open=${payable.id}`,
    bill,
  )
  const accentless = await search(owner.token, 'contratos de fornecimento de cafe')
  check('Portuguese stems and folded accents still find it', ids(accentless)[0] === contract, ids(accentless))

  // 2. A key without Financial.
  const reader = await keyToken(owner, 'Phase 75 parties reader', ['knowledge:read', 'parties:read'])
  const agentKey = await keyToken(owner, 'Phase 75 agent', ['agent:connect', 'knowledge:read', 'parties:read'])
  const unscoped = await keyToken(owner, 'Phase 75 no scope', ['parties:read'])
  try {
    const hidden = await search(reader.token, invoiceQuestion)
    const nonsense = await search(reader.token, 'zqxw vvkj plomb')
    check(
      'a key without Financial gets no chunk of the invoice, answered exactly as nonsense is',
      // With the hash embedder both are empty; e5 answers its nearest passage to anything,
      // and then both are that same passage. Either way the invoice leaves no trace.
      JSON.stringify(hidden) === JSON.stringify(nonsense) &&
        !ids(hidden).includes(invoice) &&
        hidden.searched.join() === 'parties',
      { hidden: ids(hidden), nonsense: ids(nonsense), searched: hidden.searched },
    )
    check('the same key still finds the contract', ids(await search(reader.token, 'fornecimento de café'))[0] === contract)
    const refused = await call('/knowledge/search?q=contrato', { token: unscoped.token })
    check('a key without knowledge:read is refused', refused.status === 403, refused.status)

    // 3. The agent, through the same scopes.
    const previous = await ok('/agent/settings', { token: owner.token })
    await ok('/agent/settings', { method: 'PUT', token: owner.token, body: { enabled: true } })
    try {
      const found = await tool(owner.tenantId, agentKey.secret, 'search_documents', { q: 'fornecimento de café' })
      const blind = await tool(owner.tenantId, agentKey.secret, 'search_documents', { q: invoiceQuestion })
      check(
        'the agent’s search_documents cites the contract and never the invoice',
        found?.data?.[0]?.attachmentId === contract &&
          Array.isArray(blind?.data) &&
          !blind.data.some((citation) => citation.attachmentId === invoice),
        { found: found?.data?.length, blind: blind?.data?.map((citation) => citation.attachmentId) ?? blind },
      )
    } finally {
      await call('/agent/settings', { method: 'PUT', token: owner.token, body: { enabled: previous.enabled } })
    }
  } finally {
    for (const key of [reader, agentKey, unscoped]) await call(`/identity/api-keys/${key.id}`, { method: 'DELETE', token: owner.token })
  }

  // 4. A canary in another workspace.
  const other = await workspace('b')
  const canaryMarker = `canario${randomBytes(4).toString('hex')}`
  const canaryText = `Relatório ultrassecreto ${canaryMarker} sobre fornecimento de café torrado.`
  const canary = await attach(
    other,
    { module: 'parties', recordType: 'party', recordId: await supplier(other, 'Canário Fase 75 LTDA') },
    'canario.txt',
    canaryText,
  )
  await until('the canary to be searchable in its own workspace', async () =>
    ids(await search(other.token, canaryMarker)).includes(canary) ? true : undefined,
  )
  const asked = await Promise.all(
    [canaryText, canaryMarker, 'relatório ultrassecreto', 'fornecimento de café'].map((q) => search(owner.token, q)),
  )
  check(
    'a canary in another workspace never appears, whatever is asked',
    asked.every((answer) => !ids(answer).includes(canary)),
    asked.map(ids),
  )

  // 5. Erasure.
  const erased = await call(`/parties/parties/${partyId}`, { method: 'DELETE', token: owner.token })
  if (erased.status !== 204) throw new Error(`erasure ${erased.status}`)
  await until('the erasure to reach search', async () =>
    ids(await search(owner.token, 'fornecimento de café')).includes(contract) ? undefined : true,
  )
  check('erasing the party takes its contract out of search', !ids(await search(owner.token, 'fornecimento de café')).includes(contract))
  return { tenantId: owner.tenantId, otherTenantId: other.tenantId }
}

let result
try {
  result = await run()
} catch (error) {
  check('the smoke ran to the end', false, String(error))
}
const passed = checks.every((entry) => entry.passed)
const record = {
  phase: 75,
  kind: 'document-search-smoke',
  baseUrl,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  passed,
  ...(result ?? {}),
  checks,
}
const file = join(root, 'docs/drills', `${startedAt.toISOString().slice(0, 10)}-phase75-search-smoke.json`)
await mkdir(dirname(file), { recursive: true })
await writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
console.log(`\n${passed ? 'passed' : 'FAILED'} — ${checks.length} checks, stored in ${file}`)
process.exit(passed ? 0 : 1)
