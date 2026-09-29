#!/usr/bin/env node
/**
 * Phase 74 smoke, against the local stack (ADR 0067, ADR 0068). In a new workspace it
 * attaches files to a party and proves:
 *   1. a text file is indexed into the tenant's own partition, its text sealed;
 *   2. a search in the tenant is planned onto that partition alone;
 *   3. an image is recorded as having no text, and the EICAR file never enters the index;
 *   4. erasing the party takes its file's vectors and key out, leaving a tombstone.
 * It stores its results in docs/drills/, and exits non-zero if any check failed.
 *
 *   node scripts/phase74-smoke.mjs [--base-url http://localhost:8000]
 */
import { execFileSync } from 'node:child_process'
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
const password = `phase74-${randomBytes(8).toString('hex')}`
const startedAt = new Date()
const checks = []

async function call(path, { method = 'GET', body, token, raw, type } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'idempotency-key': randomUUID(),
      ...(raw ? { 'content-type': type } : body === undefined ? {} : { 'content-type': 'application/json' }),
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

function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', 'horizon-postgres', 'psql', '-U', 'postgres', '-d', 'horizon_knowledge', '-tAc', sql],
    { encoding: 'utf8' },
  ).trim()
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

async function workspace() {
  const slug = `phase74-${randomBytes(3).toString('hex')}`
  const email = `owner.${slug}@horizon.local`
  const created = await ok('/auth/signup', {
    method: 'POST',
    body: { name: 'Phase 74 smoke', slug, timezone: 'America/Sao_Paulo', owner: { email, name: 'Smoke Owner', password } },
  })
  const first = await ok('/auth/login', { method: 'POST', body: { email, password } })
  const session = await ok('/auth/workspace', {
    method: 'POST',
    body: { selectionToken: first.selectionToken, tenantId: created.tenantId },
  })
  await ok(`/identity/users/${created.ownerId}/roles`, {
    method: 'POST',
    token: session.accessToken,
    body: { assignment: { module: 'parties', role: 'admin' }, operation: 'grant' },
  })
  const again = await ok('/auth/login', { method: 'POST', body: { email, password } })
  const fresh = await ok('/auth/workspace', {
    method: 'POST',
    body: { selectionToken: again.selectionToken, tenantId: created.tenantId },
  })
  return { tenantId: created.tenantId, token: fresh.accessToken }
}

/** A slot, the bytes to its signed link, and the scan's answer. */
async function attach(owner, record, fileName, contentType, bytes) {
  const slot = await ok('/files/attachments', {
    method: 'POST',
    token: owner.token,
    body: { ...record, fileName, contentType, size: bytes.length },
  })
  const uploaded = await call(slot.upload.url, { method: 'PUT', raw: bytes, type: contentType })
  if (uploaded.status !== 200) throw new Error(`upload ${uploaded.status}`)
  return until(`the scan of ${fileName}`, async () => {
    const current = await ok(`/files/attachments/${slot.attachment.id}`, { token: owner.token })
    return current.status === 'scanning' || current.status === 'uploading' ? undefined : current
  })
}

const documentOf = (attachmentId) =>
  psql(`select state || '|' || coalesce(deletion_reason, '') || '|' || chunks || '|' || (wrapped_key is null)
        from documents where attachment_id = '${attachmentId}'`)

async function run() {
  const owner = await workspace()
  const partition = `chunks_${owner.tenantId.replaceAll('-', '')}`
  const party = await ok('/parties/parties', {
    method: 'POST',
    token: owner.token,
    body: {
      kind: 'organization',
      taxId: cnpj(),
      roles: ['supplier'],
      legalName: 'Torrefação Índice Fase 74 LTDA',
      email: 'indice@example.com',
      phone: '1130000074',
      address: 'Rua do Índice, 74, São Paulo',
    },
  })
  const record = { module: 'parties', recordType: 'party', recordId: party.id ?? party.partyId }
  const marker = `contrato-${randomBytes(4).toString('hex')}`

  // 1. A text file, indexed and sealed.
  const contract = await attach(
    owner,
    record,
    'contrato.txt',
    'text/plain',
    Buffer.from(`Contrato de fornecimento de café torrado, referência ${marker}.\nEntrega mensal em Campinas.`),
  )
  const indexed = await until('the contract to be indexed', async () =>
    documentOf(contract.id).startsWith('indexed|') ? documentOf(contract.id) : undefined,
  )
  const [, , chunks] = indexed.split('|')
  check('a text file is indexed into its tenant’s partition', Number(chunks) > 0 && psql(`select count(*) from ${partition}`) === chunks, indexed)
  check(
    'its text is stored sealed',
    psql(`select count(*) from ${partition} where position('${marker}' in encode(sealed_text, 'escape')) > 0`) === '0',
  )

  // 2. The plan of a search.
  const plan = psql(
    `explain (costs off) select attachment_id from chunks where tenant_id = '${owner.tenantId}'
     order by embedding <=> (select embedding from ${partition} limit 1) limit 5`,
  )
  const partitions = [...plan.matchAll(/chunks_[0-9a-f]{32}/g)].map((match) => match[0])
  check('a search in the tenant is planned onto its partition alone', partitions.length > 0 && partitions.every((name) => name === partition), plan)

  // 3. An image, and the EICAR file.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )
  const image = await attach(owner, record, 'logo.png', 'image/png', png)
  await until('the image to be settled', async () => (documentOf(image.id).startsWith('no-text|') ? true : undefined))
  check('an image is recorded as having no text', documentOf(image.id).startsWith('no-text|'), documentOf(image.id))
  const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')
  const infected = await attach(owner, record, 'eicar.txt', 'text/plain', eicar)
  const quarantined = await until('the quarantine to reach the index', async () =>
    documentOf(infected.id).startsWith('deleted|') ? documentOf(infected.id) : undefined,
  )
  check(
    'the EICAR file never enters the index',
    infected.status === 'quarantined' && quarantined === 'deleted|quarantined|0|true',
    { files: infected.status, index: quarantined },
  )

  // 4. Erasure.
  const erased = await call(`/parties/parties/${record.recordId}`, { method: 'DELETE', token: owner.token })
  if (erased.status !== 204) throw new Error(`erasure ${erased.status}`)
  const gone = await until('the erasure to reach the index', async () =>
    documentOf(contract.id).startsWith('deleted|') ? documentOf(contract.id) : undefined,
  )
  check(
    'erasing the party takes its file’s vectors and key out, and leaves a tombstone',
    gone === 'deleted|erased|0|true' && psql(`select count(*) from ${partition} where attachment_id = '${contract.id}'`) === '0',
    gone,
  )
  const status = await ok('/knowledge/status', { token: owner.token })
  // Every file of the erased party ended with it: the contract, the image and the EICAR file.
  check('the workspace status shows every file of the party ended', status.documents.deleted === 3 && status.chunks === 0, status)
  return { tenantId: owner.tenantId, indexVersion: status.indexVersion }
}

let result
try {
  result = await run()
} catch (error) {
  check('the smoke ran to the end', false, String(error))
}
const passed = checks.every((entry) => entry.passed)
const record = {
  phase: 74,
  kind: 'document-index-smoke',
  baseUrl,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  passed,
  ...(result ?? {}),
  checks,
}
const file = join(root, 'docs/drills', `${startedAt.toISOString().slice(0, 10)}-phase74-index-smoke.json`)
await mkdir(dirname(file), { recursive: true })
await writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
console.log(`\n${passed ? 'passed' : 'FAILED'} — ${checks.length} checks, stored in ${file}`)
process.exit(passed ? 0 : 1)
