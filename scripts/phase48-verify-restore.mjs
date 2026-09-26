#!/usr/bin/env node
/**
 * Verifies a restored Fiscal against the live one, for every document model.
 *
 * For up to three settled documents of NF-e 55, NFC-e 65 and NFS-e, the restored Fiscal
 * must list the same artifacts as the live one, and every artifact it serves must have the
 * listed size and SHA-256. Another tenant must get 404 from the restored Fiscal.
 *
 *   node scripts/phase48-verify-restore.mjs --restored http://localhost:13011
 *     [--live http://localhost:8000/fiscal] [--tenant <uuid>] [--summary]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const restored = flag('restored')
if (!restored) {
  console.error('usage: node scripts/phase48-verify-restore.mjs --restored <url> [--live <url>]')
  process.exit(2)
}
const live = flag('live', 'http://localhost:8000/fiscal').replace(/\/$/, '')
const tenantId = flag('tenant', '01a0c5f8-798b-721e-912e-9b505406e614')

function token(tenant) {
  return execFileSync(
    process.execPath,
    [
      join(root, 'infra/scripts/mint-dev-token.mjs'),
      '--tenant',
      tenant,
      '--sub',
      randomUUID(),
      '--role',
      'fiscal:viewer',
    ],
    { encoding: 'utf8' },
  ).trim()
}

const authorization = `Bearer ${token(tenantId)}`
const get = (base, path, auth = authorization) =>
  fetch(`${base}${path}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(20_000) })
const json = async (base, path) => {
  const response = await get(base, path)
  assert.equal(response.status, 200, `${base}${path}: HTTP ${response.status}`)
  return response.json()
}

const evidence = { checkedAt: new Date().toISOString(), tenantId, restored, models: {} }
let checked = 0
for (const model of ['55', '65', 'nfse']) {
  const settled = []
  for (const status of ['authorized', 'cancelled']) {
    const page = await json(live, `/documents?model=${model}&status=${status}&limit=3`)
    settled.push(...page.data)
  }
  const documents = settled.slice(0, 3)
  assert.ok(documents.length > 0, `No settled ${model} document to verify`)
  const rows = []
  for (const document of documents) {
    const path = `/documents/${document.id}/artifacts`
    const [expected, found] = await Promise.all([json(live, path), json(restored, path)])
    const key = (artifact) => `${artifact.kind}:${artifact.digest}:${artifact.byteSize}`
    assert.deepEqual(found.artifacts.map(key).sort(), expected.artifacts.map(key).sort())
    for (const artifact of found.artifacts) {
      const response = await get(restored, `${path}/${artifact.kind}?digest=${artifact.digest}`)
      assert.equal(response.status, 200, `${artifact.kind} of ${document.id}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.equal(bytes.length, artifact.byteSize)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.digest)
      checked += 1
    }
    rows.push({ documentId: document.id, status: document.status, artifacts: found.artifacts.length })
  }
  evidence.models[model] = rows
}
const other = await get(
  restored,
  `/documents/${evidence.models['55'][0].documentId}/artifacts`,
  `Bearer ${token(randomUUID())}`,
)
assert.equal(other.status, 404)
evidence.crossTenant = other.status
evidence.artifactsVerified = checked
console.log(
  JSON.stringify(
    args.includes('--summary')
      ? { artifactsVerified: checked, crossTenant: other.status }
      : evidence,
    null,
    2,
  ),
)
