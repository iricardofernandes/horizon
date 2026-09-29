#!/usr/bin/env node
/**
 * Phase 77 smoke, against the local stack through Kong (ADR 0067, ADR 0069).
 *
 * Without the `ai` profile (`--expect-off`), it proves suggestions are off: the form asks,
 * and gets `available: false`. With `make up-ai`, in two new workspaces, it proves:
 *   1. an item named like an earlier one gets that item's NCM, with it as the reason;
 *   2. an item the workspace never classified gets official codes only, and how often the
 *      table alone names the right heading is measured on twelve products and recorded;
 *   3. another workspace's item never votes;
 *   4. a payable for a known supplier gets the category of that supplier's payables;
 *   5. an item saved with an accepted suggestion leaves the same audit entry as one typed.
 * Results go to docs/drills/; non-zero on failure.
 *
 *   node scripts/phase77-smoke.mjs [--base-url http://localhost:8000] [--expect-off]
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
const password = `phase77-${randomBytes(8).toString('hex')}`
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
  const slug = `phase77-${label}-${randomBytes(3).toString('hex')}`
  const email = `owner.${slug}@horizon.local`
  const created = await ok('/auth/signup', {
    method: 'POST',
    body: { name: `Phase 77 ${label}`, slug, timezone: 'America/Sao_Paulo', owner: { email, name: 'Smoke Owner', password } },
  })
  const first = await signIn(email, created.tenantId)
  for (const module of ['parties', 'financial', 'catalog'])
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

const expectOff = args.includes('--expect-off')
const suggest = (token, kind, text, partyId) =>
  ok(`/knowledge/suggestions/${kind}?${new URLSearchParams({ text, ...(partyId ? { partyId } : {}) })}`, { token })

/** A unit, once Catalog knows the new workspace: provisioning reaches it asynchronously. */
async function unit(owner) {
  const code = `U${randomBytes(2).toString('hex')}`.toUpperCase().slice(0, 6)
  const created = await until('the workspace in Catalog', async () => {
    const answer = await call('/catalog/units', {
      method: 'POST',
      token: owner.token,
      body: { code, name: 'Unidade', decimalPlaces: 0 },
    })
    return answer.status < 300 ? answer.body : undefined
  })
  return created.id ?? created.unitId
}

async function item(owner, unitId, name, ncm) {
  const created = await ok('/catalog/items', {
    method: 'POST',
    token: owner.token,
    body: { kind: 'product', sku: `P77-${randomBytes(3).toString('hex')}`, name, unitId, ...(ncm ? { ncm } : {}) },
  })
  return created.id ?? created.itemId
}

async function runOff() {
  const owner = await workspace('off')
  const answer = await suggest(owner.token, 'ncm', 'Café torrado em grãos 500g')
  check('without the ai profile, suggestions are off and the form gets none', answer.available === false && answer.suggestions.length === 0, answer)
  return { tenantId: owner.tenantId }
}

async function run() {
  const owner = await workspace('a')
  const unitId = await unit(owner)

  // 1. The workspace's own history.
  const coffee = await item(owner, unitId, 'Café torrado em grãos 500g', '0901.21.00')
  const learnt = await until('the item to reach the history', async () => {
    const answer = await suggest(owner.token, 'ncm', 'Café torrado em grãos 1kg')
    return answer.suggestions.some((suggestion) => suggestion.reason.examples.some((example) => example.sourceId === coffee))
      ? answer
      : undefined
  })
  const [first] = learnt.suggestions
  check(
    'an item named like an earlier one gets its NCM, with that item as the reason',
    learnt.available === true && first?.value === '09012100' && first.reason.examples[0]?.sourceId === coffee,
    first,
  )

  // 2. The official table: a candidate, never the workspace's unrelated items.
  const screws = await suggest(owner.token, 'ncm', 'Parafuso sextavado de aço inoxidável')
  check(
    'an item the workspace never classified gets official codes only, not its unrelated items',
    screws.suggestions.length > 0 &&
      screws.suggestions.every((suggestion) => suggestion.reason.officialTable && suggestion.reason.examples.length === 0),
    screws.suggestions.map((suggestion) => [suggestion.value, suggestion.reason.examples.length]),
  )
  // How often the table alone names the right heading: measured and recorded, not a gate.
  const probes = [
    ['Café torrado em grãos', '0901'], ['Parafuso sextavado de aço inoxidável', '7318'],
    ['Cadeira de escritório giratória', '9401'], ['Notebook 14 polegadas', '8471'],
    ['Papel sulfite A4', '4802'], ['Açúcar cristal', '1701'], ['Camiseta de algodão', '6109'],
    ['Detergente líquido', '3402'], ['Cimento Portland', '2523'], ['Pneu para automóvel', '4011'],
    ['Arroz branco tipo 1', '1006'], ['Leite UHT integral', '0401'],
  ]
  const fresh = await workspace('table')
  const probed = []
  for (const [name, heading] of probes) {
    const answer = await suggest(fresh.token, 'ncm', name)
    probed.push({ name, heading, suggested: answer.suggestions.map((suggestion) => suggestion.value), hit: answer.suggestions.some((suggestion) => suggestion.value.startsWith(heading)) })
  }
  const officialTable = { headingHitAt3: probed.filter((probe) => probe.hit).length, of: probed.length, probes: probed }

  // 3. Another workspace.
  const other = await workspace('b')
  const otherUnit = await unit(other)
  const marker = `canario${randomBytes(3).toString('hex')}`
  const canary = await item(other, otherUnit, `Chá mate ${marker}`, '0903.00.10')
  await until('the canary to reach its own history', async () =>
    (await suggest(other.token, 'ncm', `Chá mate ${marker}`)).suggestions.some((suggestion) =>
      suggestion.reason.examples.some((example) => example.sourceId === canary),
    )
      ? true
      : undefined,
  )
  const asked = await suggest(owner.token, 'ncm', `Chá mate ${marker}`)
  check(
    'another workspace’s item never votes',
    !JSON.stringify(asked).includes(canary) && asked.suggestions.every((suggestion) => suggestion.reason.examples.every((example) => example.sourceId !== canary)),
    asked.suggestions.map((suggestion) => ({ value: suggestion.value, examples: suggestion.reason.examples.length })),
  )

  // 4. A payable's category.
  const categories = (await ok('/financial/categories', { token: owner.token })).data
  const category =
    categories.find((entry) => entry.nature === 'expense' && entry.active !== false) ??
    (await ok('/financial/categories', {
      method: 'POST',
      token: owner.token,
      body: { code: `P77-${randomBytes(2).toString('hex')}`, name: 'Matéria-prima', nature: 'expense' },
    }))
  const partyId = await supplier(owner, 'Torrefação Sugestão Fase 77 LTDA')
  // Below the threshold, a payable posts without an approver: this smoke has one person.
  await ok('/financial/payables/approval-policies', {
    method: 'PUT',
    token: owner.token,
    body: { currency: 'BRL', threshold: '100000000' },
  })
  const today = new Date().toISOString().slice(0, 10)
  const payable = await until('the supplier in Financial', async () => {
    const drafted = await call('/financial/payables', {
      method: 'POST',
      token: owner.token,
      body: {
        partyId,
        documentNumber: `NF-77-${randomBytes(3).toString('hex')}`,
        description: 'Café verde em sacas para torra',
        currency: 'BRL',
        categoryId: category.id,
        issuedOn: today,
        installments: [{ dueOn: today, amount: '150000' }],
      },
    })
    return drafted.status < 300 ? drafted.body : undefined
  })
  await ok(`/financial/payables/${payable.id}/post`, { method: 'POST', token: owner.token, body: {} })
  const categorised = await until('the payable to reach the history', async () => {
    const answer = await suggest(owner.token, 'payable-category', 'Torrefação Sugestão Fase 77 LTDA café verde', partyId)
    return answer.suggestions.length ? answer : undefined
  })
  check(
    'a payable for a known supplier gets the category of that supplier’s payables',
    categorised.suggestions[0]?.value === category.id && categorised.suggestions[0].reason.examples[0]?.sameParty === true,
    categorised.suggestions[0],
  )

  // 5. Accepting is typing.
  const typed = await item(owner, unitId, 'Café torrado moído 250g', '0901.21.00')
  const accepted = await item(owner, unitId, 'Café torrado moído 500g', first.value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1.$2.$3'))
  const decision = await call('/knowledge/suggestions/decisions', {
    method: 'POST',
    token: owner.token,
    body: { kind: 'ncm', decision: 'accepted', rank: 1 },
  })
  const audit = async (id) =>
    (await ok(`/catalog/audit?subjectId=${id}`, { token: owner.token })).data.find((entry) => entry.action === 'catalog.item.created')
  const [typedEntry, acceptedEntry] = await Promise.all([audit(typed), audit(accepted)])
  const shape = (entry) => ({ action: entry?.action, actor: entry?.actor, keys: Object.keys(entry?.details ?? {}).sort(), ncm: entry?.details?.ncm })
  check(
    'an item saved with an accepted suggestion leaves the same audit entry as one typed',
    decision.status === 204 && typedEntry && JSON.stringify(shape(typedEntry)) === JSON.stringify(shape(acceptedEntry)),
    { decision: decision.status, typed: shape(typedEntry), accepted: shape(acceptedEntry) },
  )
  return { tenantId: owner.tenantId, otherTenantId: other.tenantId, officialTable }
}

let result
try {
  result = expectOff ? await runOff() : await run()
} catch (error) {
  check('the smoke ran to the end', false, String(error))
}
const passed = checks.every((entry) => entry.passed)
const record = {
  phase: 77,
  kind: expectOff ? 'suggestions-off-smoke' : 'suggestions-smoke',
  baseUrl,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  passed,
  ...(result ?? {}),
  checks,
}
const file = join(root, 'docs/drills', `${startedAt.toISOString().slice(0, 10)}-phase77-suggestions-${expectOff ? 'off' : 'smoke'}.json`)
await mkdir(dirname(file), { recursive: true })
await writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
console.log(`\n${passed ? 'passed' : 'FAILED'} — ${checks.length} checks, stored in ${file}`)
process.exit(passed ? 0 : 1)
