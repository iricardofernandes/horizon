#!/usr/bin/env node
/**
 * Phase 64 local-stack smoke: a go-live loaded through the import job contract, through
 * Kong and through the web proxy, in a fresh workspace.
 *
 * Parties: 1,500 companies and three bad rows; Parties is killed while writing and
 * started again, and every company is written once. The same file under the same key is
 * the same job. The failures download with their lines and reasons. Catalog: units by
 * CSV, then items by XLSX, then prices. Inventory: opening stock by warehouse name and item
 * id. Financial: open receivables of the imported customers, once Parties has told
 * Financial about them. A user without the role is refused. Every job's counts add up.
 *
 *   node scripts/phase64-smoke.mjs [--base-url http://localhost:8000] [--web-url http://localhost:3000]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { strToU8, zipSync } = createRequire(join(root, 'reporting/package.json'))('fflate')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const baseUrl = flag('base-url', 'http://localhost:8000').replace(/\/$/, '')
const webUrl = flag('web-url', 'http://localhost:3000').replace(/\/$/, '')
const tenantId = randomUUID()
const PARTIES = Number(flag('parties', '1500'))

function token(roles, sub = randomUUID()) {
  return execFileSync(
    process.execPath,
    [join(root, 'infra/scripts/mint-dev-token.mjs'), '--tenant', tenantId, '--sub', sub, ...roles.flatMap((role) => ['--role', role])],
    { encoding: 'utf8' },
  ).trim()
}

const admin = token(['parties:admin', 'catalog:admin', 'inventory:admin', 'financial:admin'])
const editor = token(['parties:editor', 'catalog:editor', 'inventory:operator', 'financial:operator'])

async function call(url, { method = 'GET', body, bearer = admin, key, cookie } = {}) {
  const response = await fetch(url.startsWith('http') ? url : `${baseUrl}${url}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : { authorization: `Bearer ${bearer}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  const type = response.headers.get('content-type') ?? ''
  const bytes = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    headers: response.headers,
    body: type.includes('json') ? JSON.parse(bytes.toString('utf8') || 'null') : bytes.toString('utf8'),
  }
}

async function ok(url, options) {
  const result = await call(url, options)
  if (result.status >= 400) throw new Error(`${options?.method ?? 'GET'} ${url}: HTTP ${result.status} ${JSON.stringify(result.body)}`)
  return result.body
}

async function until(label, probe, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined)
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function psql(database, sql) {
  return execFileSync('docker', ['exec', 'horizon-postgres', 'psql', '-U', 'postgres', '-d', database, '-tAc', sql], {
    encoding: 'utf8',
  }).trim()
}

function addsUp(job) {
  const { total, written, failed, remaining, cancelled } = job.progress
  assert.equal(total, written + failed + remaining + cancelled, `${job.kind} counts add up`)
  return job
}

/** Upload, map with the suggestion, preview and confirm; returns the confirmed job. */
async function start(prefix, kind, file, { via = 'kong', key = randomUUID() } = {}) {
  const url = via === 'web' ? `${webUrl}/api/horizon/${prefix}/imports` : `/${prefix}/imports`
  const options = via === 'web' ? { cookie: `horizon_access=${admin}` } : {}
  const uploaded = await ok(`${url}/${kind}`, { ...options, method: 'POST', key, body: file })
  addsUp(uploaded)
  await ok(`${url}/${uploaded.id}/mapping`, { ...options, method: 'PUT', body: { mapping: uploaded.mapping } })
  const preview = await ok(`${url}/${uploaded.id}/preview`, { ...options, method: 'POST' })
  addsUp(preview.job)
  const confirmed = await ok(`${url}/${uploaded.id}/confirm`, { ...options, method: 'POST' })
  return { job: confirmed, preview, key, url, options }
}

async function finished(url, id, options = {}) {
  return until(`${url}/${id}`, async () => {
    const job = addsUp(await ok(`${url}/${id}`, options))
    return ['completed', 'completed-with-failures', 'cancelled'].includes(job.status) ? job : undefined
  })
}

const csv = (lines) => ({ fileName: 'arquivo.csv', format: 'csv', locale: 'pt-BR', content: lines.join('\r\n') })

function xlsx(rows) {
  const cell = (value, reference) =>
    typeof value === 'number'
      ? `<c r="${reference}"><v>${value}</v></c>`
      : `<c r="${reference}" t="inlineStr"><is><t>${String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</t></is></c>`
  const sheet = rows
    .map((cells, row) => `<row r="${row + 1}">${cells.map((value, column) => cell(value, `${String.fromCharCode(65 + column)}${row + 1}`)).join('')}</row>`)
    .join('')
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook><sheets><sheet name="Itens" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet><sheetData>${sheet}</sheetData></worksheet>`,
  }
  const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])))
  return { fileName: 'itens.xlsx', format: 'xlsx', locale: 'en', content: Buffer.from(bytes).toString('base64') }
}

const results = []
const record = (step, detail) => {
  results.push({ step, ...detail })
  console.log(`✓ ${step}`, JSON.stringify(detail))
}

// --- Parties: a big file, killed mid-import ------------------------------------------
const cnpj = (index) => `${String(20_000_000 + index).padStart(8, '0')}000195`
const partyLines = [
  'Tipo;Razão Social;CNPJ;E-mail;Telefone;Endereço;Papéis',
  ...Array.from({ length: PARTIES }, (_, index) => `PJ;Cliente ${index} LTDA;${cnpj(index)};contato${index}@cliente.example;1133330000;Rua ${index}, 10, São Paulo;cliente`),
  'PJ;Sem Documento Válido;123;x@y.example;1133330000;Rua A, 1, SP;cliente',
  `PJ;Repetida LTDA;${cnpj(0)};r@example.com;1133330000;Rua B, 2, SP;cliente`,
  'Robô;Tipo Estranho;;;;;prospecto',
]
const partiesFile = csv(partyLines)
const parties = await start('parties', 'parties', partiesFile)
assert.equal(parties.preview.job.progress.valid, PARTIES)
assert.equal(parties.preview.errors.length, 3)
await until('parties writing', async () => {
  const job = await ok(`/parties/imports/${parties.job.id}`)
  return job.progress.written > 50 && job.progress.remaining > 0 ? job : undefined
}, 60_000)
execFileSync('docker', ['kill', 'horizon-parties'])
const writtenAtKill = Number(psql('horizon_parties', `select count(*) from parties where tenant_id = '${tenantId}'`))
execFileSync('docker', ['start', 'horizon-parties'])
await until('parties healthy', async () => (await call('/parties/health/ready')).status === 200)
const partiesDone = await finished('/parties/imports', parties.job.id)
const partiesWritten = Number(psql('horizon_parties', `select count(*) from parties where tenant_id = '${tenantId}'`))
assert.equal(partiesDone.status, 'completed-with-failures')
assert.equal(partiesDone.progress.written, PARTIES)
assert.equal(partiesWritten, PARTIES)
record('parties killed mid-import and resumed', { writtenAtKill, written: partiesWritten, progress: partiesDone.progress })

const again = await call(`/parties/imports/parties`, { method: 'POST', key: parties.key, body: partiesFile })
assert.equal(again.status, 200)
assert.equal(again.body.id, parties.job.id)
const otherFile = await call(`/parties/imports/parties`, { method: 'POST', key: parties.key, body: csv(partyLines.slice(0, 3)) })
assert.equal(otherFile.status, 409)
await new Promise((resolve) => setTimeout(resolve, 3000))
assert.equal(Number(psql('horizon_parties', `select count(*) from parties where tenant_id = '${tenantId}'`)), PARTIES)
record('same key and file', { status: again.status, sameJob: true, otherFile: otherFile.status, parties: PARTIES })

const failures = await call(`/parties/imports/${parties.job.id}/failures`)
const failureLines = failures.body.replace(/^﻿/, '').trim().split('\r\n')
assert.equal(failureLines[0], 'Tipo;Razão Social;CNPJ;E-mail;Telefone;Endereço;Papéis;linha;motivo')
assert.equal(failureLines.length, 4)
assert.match(failures.headers.get('content-disposition') ?? '', /arquivo-falhas\.csv/)
record('failures file', { lines: failureLines.slice(1).map((line) => line.split(';').slice(-2).join(' → ')) })

const sealed = psql('horizon_parties', `select count(*) from import_rows where tenant_id = '${tenantId}' and cells like '%Cliente%'`)
assert.equal(sealed, '0')
record('import rows sealed', { clearNames: Number(sealed) })

for (const [prefix, kind] of [['parties', 'parties'], ['catalog', 'items'], ['inventory', 'opening-stock'], ['financial', 'receivables']]) {
  const refused = await call(`/${prefix}/imports/${kind}`, { method: 'POST', key: randomUUID(), bearer: editor, body: csv(['a', 'b']) })
  const listed = await call(`/${prefix}/imports`, { bearer: editor })
  assert.equal(refused.status, 403)
  assert.equal(listed.status, 403)
}
record('no role, no import', { modules: 4, status: 403 })

// --- Catalog: units, then items by XLSX, then prices, through the web proxy ------------
const units = await start('catalog', 'units', csv(['Código;Nome;Decimais', 'UN;Unidade;0', 'KG;Quilograma;3', 'kg;Repetida;0', '1?;Inválida;9']), { via: 'web' })
const unitsDone = await finished(units.url, units.job.id, units.options)
assert.deepEqual([unitsDone.progress.written, unitsDone.progress.failed], [2, 2])
const items = await start('catalog', 'items', xlsx([
  ['SKU', 'Name', 'Unit', 'NCM'],
  ['CAF-1', 'Café em grãos', 'KG', 9012100],
  ['CAF-2', 'Café moído', 'KG', ''],
  ['XIC-1', 'Xícara', 'UN', ''],
  ['BAD-1', 'Unidade inexistente', 'CX', ''],
]))
const itemsDone = await finished('/catalog/imports', items.job.id)
assert.deepEqual([itemsDone.progress.written, itemsDone.progress.failed], [3, 1])
const catalogItems = (await ok('/catalog/items?limit=100')).data
const bySku = Object.fromEntries(catalogItems.map((item) => [item.sku, item.id]))
const prices = await start('catalog', 'prices', csv(['Lista;Moeda;SKU;Preço', 'Varejo;BRL;CAF-1;49,90', 'Varejo;BRL;XIC-1;19,5', 'Varejo;BRL;NOPE;1']))
const pricesDone = await finished('/catalog/imports', prices.job.id)
assert.deepEqual([pricesDone.progress.written, pricesDone.progress.failed], [2, 1])
const itemsFailures = await call(`/catalog/imports/${items.job.id}/failures`)
assert.equal(itemsFailures.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
record('catalog', { units: unitsDone.progress, items: itemsDone.progress, prices: pricesDone.progress, ncmKeptItsZero: catalogItems.find((item) => item.sku === 'CAF-1')?.ncm })

// --- Inventory: opening stock ---------------------------------------------------------
await ok('/inventory/warehouses', { method: 'POST', body: { name: 'Central' } })
const stock = await start('inventory', 'opening-stock', csv([
  'Depósito;Item;Quantidade;Custo unitário;Moeda',
  `Central;${bySku['CAF-1']};12,5;38,40;BRL`,
  `Central;${bySku['XIC-1']};40;7;BRL`,
  `Filial;${bySku['CAF-2']};1;1;BRL`,
]))
const stockDone = await finished('/inventory/imports', stock.job.id)
assert.deepEqual([stockDone.progress.written, stockDone.progress.failed], [2, 1])
const onHand = psql('horizon_inventory', `select sum(on_hand) from stock_balances where tenant_id = '${tenantId}'`)
assert.equal(onHand, '52500000')
record('inventory', { progress: stockDone.progress, onHandMicros: onHand })

// --- Financial: open receivables of the imported customers ----------------------------
await ok('/financial/categories', { method: 'POST', body: { code: '1.01', name: 'Vendas', nature: 'revenue' } })
const customers = (await ok('/parties/parties?role=customer&limit=5')).data.map((party) => party.id)
await until('financial knows the customers', async () =>
  Number(psql('horizon_financial', `select count(*) from party_projection where tenant_id = '${tenantId}' and party_id in (${customers.map((id) => `'${id}'`).join(',')})`)) === 5,
)
const receivables = await start('financial', 'receivables', csv([
  'Parceiro;Documento;Emissão;Vencimento;Valor;Moeda;Categoria',
  ...customers.map((id, index) => `${id};NF-${index};01/09/2026;30/10/2026;1.000,${String(index).padStart(2, '0')};BRL;1.01`),
  `${randomUUID()};NF-X;01/09/2026;30/10/2026;10;BRL;1.01`,
]), { via: 'web' })
const receivablesDone = await finished(receivables.url, receivables.job.id, receivables.options)
assert.deepEqual([receivablesDone.progress.written, receivablesDone.progress.failed], [5, 1])
const open = psql('horizon_financial', `select sum(outstanding) from title_installments where tenant_id = '${tenantId}'`)
assert.equal(open, String(5 * 100_000 + 0 + 1 + 2 + 3 + 4))
record('financial', { progress: receivablesDone.progress, outstandingMinor: open })

const page = await call(`${webUrl}/app/administration/imports`, { cookie: `horizon_access=${admin}` })
assert.equal(page.status, 200)
record('web wizard page', { status: page.status })

console.log(`\nPhase 64 smoke passed for tenant ${tenantId}: ${results.length} steps.`)
