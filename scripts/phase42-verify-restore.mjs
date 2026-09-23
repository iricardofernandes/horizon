#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const evidencePath = flag('evidence')
if (!evidencePath) {
  console.error('usage: node scripts/phase42-verify-restore.mjs --evidence <smoke-output.json> [--base-url <url>]')
  process.exit(2)
}
const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
assert.match(evidence.tenantId, /^[0-9a-f-]{36}$/)
assert.match(evidence.documentId, /^[0-9a-f-]{36}$/)
const expected = [
  ...(evidence.artifactsBeforeCancellation ?? []),
  ...(evidence.artifactsAfterCancellation ?? []),
]
assert.ok(expected.length > 0, 'Smoke evidence has no artifact digests')
const baseUrl = flag('base-url', 'http://localhost:8000/fiscal').replace(/\/$/, '')

function token(tenantId) {
  return execFileSync(
    process.execPath,
    [
      join(root, 'infra/scripts/mint-dev-token.mjs'), '--tenant', tenantId,
      '--sub', randomUUID(), '--role', 'fiscal:admin',
    ],
    { encoding: 'utf8' },
  ).trim()
}

const authorization = `Bearer ${token(evidence.tenantId)}`
const path = `/documents/${evidence.documentId}/artifacts`
const listed = await fetch(`${baseUrl}${path}`, { headers: { authorization } })
assert.equal(listed.status, 200)
assert.equal(listed.headers.get('cache-control'), 'private, no-store')
const metadata = (await listed.json()).artifacts
for (const artifact of expected) {
  assert.ok(metadata.some((row) => row.kind === artifact.kind && row.digest === artifact.digest))
  const response = await fetch(
    `${baseUrl}${path}/${artifact.kind}?digest=${artifact.digest}`,
    { headers: { authorization }, signal: AbortSignal.timeout(20_000) },
  )
  assert.equal(response.status, 200)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.length, artifact.byteSize)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.digest)
}
const otherAuthorization = `Bearer ${token(randomUUID())}`
const hidden = await fetch(`${baseUrl}${path}`, {
  headers: { authorization: otherAuthorization },
})
assert.equal(hidden.status, 404)
process.stdout.write(`${JSON.stringify({
  checkedAt: new Date().toISOString(),
  documentId: evidence.documentId,
  verifiedArtifacts: expected.length,
  crossTenantStatus: hidden.status,
  restored: true,
}, null, 2)}\n`)
