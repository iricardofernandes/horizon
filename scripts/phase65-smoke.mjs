#!/usr/bin/env node
/**
 * Phase 65 local-stack smoke: attachments through Kong and the web proxy, in a fresh
 * workspace.
 *
 * A PDF attached to a party is scanned, served decrypted, and stored only as ciphertext.
 * A PNG goes on a payable through the web proxy. The EICAR test file is quarantined, its
 * bytes removed, and no link opens it. A user without the owning module's role cannot
 * list or attach, a viewer can list but not attach, and another tenant sees nothing.
 * Erasing the party shreds its key: its attachment ends and is never readable again.
 *
 *   node scripts/phase65-smoke.mjs [--base-url http://localhost:8000] [--web-url http://localhost:3000] [--scanner eicar|clamav]
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
const baseUrl = flag('base-url', 'http://localhost:8000').replace(/\/$/, '')
const webUrl = flag('web-url', 'http://localhost:3000').replace(/\/$/, '')
const scanner = flag('scanner', 'eicar')
const tenantId = randomUUID()

function token(roles, { tenant = tenantId, sub = randomUUID() } = {}) {
  return execFileSync(
    process.execPath,
    [join(root, 'infra/scripts/mint-dev-token.mjs'), '--tenant', tenant, '--sub', sub, ...roles.flatMap((role) => ['--role', role])],
    { encoding: 'utf8' },
  ).trim()
}

const admin = token(['parties:admin', 'financial:admin', 'procurement:admin', 'sales:admin', 'crm:admin'])
const outsider = token(['catalog:admin', 'parties:fiscal-reader'])
const viewer = token(['parties:viewer', 'financial:viewer'])
const stranger = token(['parties:admin', 'financial:admin'], { tenant: randomUUID() })

async function call(url, { method = 'GET', body, bearer = admin, key, cookie, type, raw } = {}) {
  const headers = {
    ...(cookie ? { cookie } : bearer ? { authorization: `Bearer ${bearer}` } : {}),
    ...(raw ? { 'content-type': type } : body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(key ? { 'idempotency-key': key } : {}),
  }
  const response = await fetch(url.startsWith('http') ? url : `${baseUrl}${url}`, {
    method,
    headers,
    ...(raw ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  const contentType = response.headers.get('content-type') ?? ''
  const bytes = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    body: contentType.includes('json') ? JSON.parse(bytes.toString('utf8') || 'null') : bytes.toString('utf8'),
  }
}

async function ok(url, options) {
  const result = await call(url, options)
  if (result.status >= 400) throw new Error(`${options?.method ?? 'GET'} ${url}: HTTP ${result.status} ${JSON.stringify(result.body)}`)
  return result.body
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
  return execFileSync('docker', ['exec', 'horizon-postgres', 'psql', '-U', 'postgres', '-d', 'horizon_files', '-tAc', sql], {
    encoding: 'utf8',
  }).trim()
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

const results = []
const record = (step, detail) => {
  results.push({ step, ...detail })
  console.log(`✓ ${step}`, JSON.stringify(detail))
}

/** A slot, then the bytes to its signed link; answers the attachment once its scan answered. */
async function attach(record, fileName, contentType, bytes, { via = 'kong' } = {}) {
  const prefix = via === 'web' ? `${webUrl}/api/horizon` : baseUrl
  const auth = via === 'web' ? { cookie: `horizon_access=${admin}` } : {}
  const slot = await ok(`${prefix}/files/attachments`, {
    ...auth,
    method: 'POST',
    key: randomUUID(),
    body: { ...record, fileName, contentType, size: bytes.length },
  })
  assert.equal(slot.attachment.status, 'uploading')
  assert.equal(slot.upload.method, 'PUT')
  const uploaded = await call(`${prefix}${slot.upload.url}`, { ...auth, bearer: null, method: 'PUT', type: contentType, raw: bytes })
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body))
  return until(`scan of ${fileName}`, async () => {
    const current = await ok(`/files/attachments/${slot.attachment.id}`)
    return current.status === 'scanning' ? undefined : current
  })
}

// --- A party and its contract ----------------------------------------------------------
const party = await ok('/parties/parties', {
  method: 'POST',
  body: {
    kind: 'organization',
    taxId: cnpj(),
    roles: ['supplier'],
    legalName: 'Fornecedor Anexos Fase 65 LTDA',
    email: 'anexos@example.com',
    phone: '1130000000',
    address: 'Rua dos Anexos, 65, São Paulo',
  },
})
const partyId = party.id ?? party.partyId
const partyRecord = { module: 'parties', recordType: 'party', recordId: partyId }
const pdf = Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Title (Contrato social ${randomUUID()}) >>\nendobj\n%%EOF\n`)
const contract = await attach(partyRecord, 'Contrato social – Fornecedor.pdf', 'application/pdf', pdf)
assert.equal(contract.status, 'available')
assert.equal(contract.expiresAt, null)
const link = await ok(`/files/attachments/${contract.id}/link`)
assert.equal(link.method, 'GET')
const download = await call(link.url, { bearer: null })
assert.equal(download.status, 200)
assert.deepEqual(download.bytes, pdf)
assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename="Contrato social _ Fornecedor\.pdf"; filename\*=UTF-8''Contrato%20social%20_%20Fornecedor\.pdf$/)
const [bucket, key] = ['horizon-attachments', `attachments/${tenantId}/${contract.id}`]
// MinIO keeps a small object inside its metadata file: the bytes it holds are ciphertext.
const stored = execFileSync('docker', ['exec', 'horizon-minio', 'cat', `/data/${bucket}/${key}/xl.meta`])
const clear = stored.includes(Buffer.from('Contrato social')) || stored.includes(Buffer.from('/Catalog')) ? 1 : 0
assert.equal(clear, 0)
record('a pdf on a party, served decrypted', { status: contract.status, bytes: pdf.length, storedMetaBytes: stored.length, plaintextInStorage: clear })

// --- A receipt on a payable, through the web proxy ------------------------------------
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
const payable = { module: 'financial', recordType: 'payable', recordId: randomUUID(), ownerPartyId: partyId }
const receipt = await attach(payable, 'comprovante.png', 'image/png', png, { via: 'web' })
assert.equal(receipt.status, 'available')
assert.ok(receipt.expiresAt, 'a payable file has a retention end')
const years = (new Date(receipt.expiresAt) - new Date(receipt.availableAt)) / (365.25 * 86_400_000)
assert.ok(years > 4.99 && years < 5.01)
const webLink = await ok(`${webUrl}/api/horizon/files/attachments/${receipt.id}/link`, { cookie: `horizon_access=${admin}` })
const webDownload = await call(`${webUrl}/api/horizon${webLink.url}`, { cookie: `horizon_access=${admin}` })
assert.deepEqual(webDownload.bytes, png)
record('a receipt on a payable, through the web proxy', { status: receipt.status, retentionYears: Number(years.toFixed(2)) })

// --- EICAR ---------------------------------------------------------------------------
const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')
const infected = await attach(payable, 'eicar.txt', 'text/plain', eicar)
assert.equal(infected.status, 'quarantined')
const refusedLink = await call(`/files/attachments/${infected.id}/link`)
assert.equal(refusedLink.status, 409)
const forged = new URL(link.url, baseUrl)
const forgedDownload = await call(`${forged.pathname.replace(contract.id, infected.id)}${forged.search}`, { bearer: null })
assert.equal(forgedDownload.status, 403)
const removal = psql(`select reason || ':' || bytes from attachment_removals where attachment_id = '${infected.id}'`)
assert.equal(removal, `quarantined:${eicar.length}`)
const objectLeft = execFileSync('docker', ['exec', 'horizon-minio', 'sh', '-c', `test -e /data/horizon-attachments/attachments/${tenantId}/${infected.id} && echo yes || echo no`], { encoding: 'utf8' }).trim()
assert.equal(objectLeft, 'no')
record('eicar quarantined, removed and never served', { scanner, finding: infected.finding, link: refusedLink.status, forged: forgedDownload.status, removal })

// --- Declarations the upload must keep -----------------------------------------------
const tooBig = await call('/files/attachments', { method: 'POST', key: randomUUID(), body: { ...payable, fileName: 'big.pdf', contentType: 'application/pdf', size: 10 * 1024 * 1024 + 1 } })
const html = await call('/files/attachments', { method: 'POST', key: randomUUID(), body: { ...payable, fileName: 'page.html', contentType: 'text/html', size: 10 } })
const lying = await ok('/files/attachments', { method: 'POST', key: randomUUID(), body: { ...payable, fileName: 'fake.pdf', contentType: 'application/pdf', size: 16 } })
const notPdf = await call(lying.upload.url, { bearer: null, method: 'PUT', type: 'application/pdf', raw: Buffer.from('<script>1</script>') })
const wrongType = await call(lying.upload.url, { bearer: null, method: 'PUT', type: 'image/png', raw: Buffer.alloc(16) })
assert.deepEqual([tooBig.status, html.status, notPdf.status, wrongType.status], [400, 400, 400, 400])
record('declarations enforced', { tooBig: tooBig.status, html: html.status, notPdf: notPdf.status, wrongType: wrongType.status })

// --- Roles and tenancy ----------------------------------------------------------------
const query = `?module=parties&recordType=party&recordId=${partyId}`
const outsiderList = await call(`/files/attachments${query}`, { bearer: outsider })
const outsiderOne = await call(`/files/attachments/${contract.id}`, { bearer: outsider })
const outsiderLink = await call(`/files/attachments/${contract.id}/link`, { bearer: outsider })
const outsiderSlot = await call('/files/attachments', { bearer: outsider, method: 'POST', key: randomUUID(), body: { ...partyRecord, fileName: 'x.pdf', contentType: 'application/pdf', size: 10 } })
assert.deepEqual([outsiderList.status, outsiderOne.status, outsiderLink.status, outsiderSlot.status], [403, 403, 403, 403])
const viewerList = await ok(`/files/attachments${query}`, { bearer: viewer })
const viewerSlot = await call('/files/attachments', { bearer: viewer, method: 'POST', key: randomUUID(), body: { ...partyRecord, fileName: 'x.pdf', contentType: 'application/pdf', size: 10 } })
const viewerDelete = await call(`/files/attachments/${contract.id}`, { bearer: viewer, method: 'DELETE' })
assert.equal(viewerList.data.length, 1)
assert.deepEqual([viewerSlot.status, viewerDelete.status], [403, 403])
record('module roles', { withoutRole: 403, viewerLists: viewerList.data.length, viewerAttaches: viewerSlot.status, viewerDeletes: viewerDelete.status })

const strangerOne = await call(`/files/attachments/${contract.id}`, { bearer: stranger })
const strangerList = await ok(`/files/attachments${query}`, { bearer: stranger })
const strangerLink = await call(`/files/attachments/${contract.id}/link`, { bearer: stranger })
assert.deepEqual([strangerOne.status, strangerList.data.length, strangerLink.status], [404, 0, 404])
record('another tenant sees nothing', { one: strangerOne.status, listed: strangerList.data.length, link: strangerLink.status })

const types = await ok('/files/record-types', { bearer: viewer })
assert.deepEqual(
  types.data.filter((type) => type.canRead).map((type) => `${type.recordType}:${type.canWrite}`),
  ['party:false', 'receivable:false', 'payable:false'],
)

// --- Removal by a person ----------------------------------------------------------------
const note = await attach(payable, 'nota.csv', 'text/csv', Buffer.from('item;valor\ncafé;10\n'))
const removed = await ok(`/files/attachments/${note.id}`, { method: 'DELETE' })
assert.equal(removed.status, 'deleted')
assert.equal(psql(`select reason from attachment_removals where attachment_id = '${note.id}'`), 'removed')
record('removed by a person, and logged', { status: removed.status, reason: removed.deletionReason })

// --- Erasure --------------------------------------------------------------------------
const erased = await call(`/parties/parties/${partyId}`, { method: 'DELETE' })
assert.equal(erased.status, 204)
const ended = await until('the party erasure to reach files', async () => {
  const current = await call(`/files/attachments/${contract.id}`)
  return current.status === 404 ? current : undefined
})
const reasons = psql(`select string_agg(id || '=' || deletion_reason, ',' order by created_at) from attachments where tenant_id = '${tenantId}' and owner_type = 'party'`)
assert.match(reasons, new RegExp(`${contract.id}=erased`))
assert.match(reasons, new RegExp(`${receipt.id}=erased`))
assert.equal(psql(`select count(*) from owner_keys where tenant_id = '${tenantId}' and owner_id = '${partyId}' and wrapped_key is null`), '1')
const staleLink = await call(link.url, { bearer: null })
assert.equal(staleLink.status, 404)
const newSlot = await call('/files/attachments', { method: 'POST', key: randomUUID(), body: { ...partyRecord, fileName: 'x.pdf', contentType: 'application/pdf', size: 10 } })
assert.equal(newSlot.status, 409)
await until('the erased bytes to be removed', async () =>
  psql(`select count(*) from attachment_removals where tenant_id = '${tenantId}' and reason = 'erased'`) === '2' ? true : undefined,
)
record('party erased: key destroyed, attachments unreadable and removed', { status: ended.status, staleLink: staleLink.status, newSlot: newSlot.status })

// --- Events carry no file name -------------------------------------------------------
const published = psql(`select string_agg(event_type, ',' order by created_at) from outbox where tenant_id = '${tenantId}'`)
const named = psql(`select count(*) from outbox where tenant_id = '${tenantId}' and (payload::text like '%Contrato%' or payload::text like '%comprovante%' or payload::text like '%eicar%')`)
assert.equal(named, '0')
const undelivered = await until('the outbox to drain', async () => (psql(`select count(*) from outbox where tenant_id = '${tenantId}' and dispatched_at is null`) === '0' ? '0' : undefined))
record('events without names', { published: published.split(',').length, withNames: Number(named), undelivered: Number(undelivered) })

// --- The web -----------------------------------------------------------------------------
const page = await call(`${webUrl}/app/finance/payables`, { cookie: `horizon_access=${admin}` })
assert.equal(page.status, 200)
record('web', { payables: page.status })

console.log(JSON.stringify({ tenantId, scanner, steps: results.length }, null, 2))
