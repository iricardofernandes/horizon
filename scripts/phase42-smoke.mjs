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
const inputPath = flag('input')
if (!inputPath) {
  console.error('usage: node scripts/phase42-smoke.mjs --input <fixture.json> [--base-url <url>]')
  process.exit(2)
}
const fixture = JSON.parse(await readFile(inputPath, 'utf8'))
const baseUrl = flag('base-url', 'http://localhost:8000/fiscal').replace(/\/$/, '')
const token = execFileSync(
  process.execPath,
  [
    join(root, 'infra/scripts/mint-dev-token.mjs'),
    '--tenant', fixture.tenantId,
    '--sub', randomUUID(),
    '--role', 'fiscal:admin',
  ],
  { encoding: 'utf8' },
).trim()
const authorization = `Bearer ${token}`
const evidence = { checkedAt: new Date().toISOString(), baseUrl, tenantId: fixture.tenantId }

async function request(path, { method = 'GET', body, key } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(result)}`)
  return { status: response.status, body: result, headers: response.headers }
}

async function waitFor(documentId, terminal, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const { body } = await request(`/documents/${documentId}`)
      if (terminal.includes(body.status)) return body
    } catch (error) {
      if (!/HTTP 50[23]|fetch failed/.test(String(error))) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Fiscal document ${documentId} did not reach ${terminal.join('/')}`)
}

const capabilities = (await request('/capabilities')).body
const active = capabilities.supported?.find(
  (row) => row.establishmentId === fixture.establishmentId && row.status === 'simulated',
)
assert.ok(active, 'The reviewed simulation capability must be active before this smoke')
assert.equal(active.model, '55')
assert.equal(active.environment, 'simulation')
evidence.capabilityId = active.id

const originKey = randomUUID()
const originBody = {
  establishmentId: fixture.establishmentId,
  issuerProfileRevision: fixture.issuerProfileRevision,
  recipientPartyId: fixture.recipientPartyId,
  recipientProfileRevision: fixture.recipientProfileRevision,
  issueDate: fixture.issueDate,
  operation: 'normal-sale',
  purpose: 'normal',
  reason: 'Execução local revisada da simulação NF-e modelo 55',
  lines: fixture.lines,
}
const origin = (await request('/manual-origins', {
  method: 'POST', body: originBody, key: originKey,
})).body
assert.deepEqual((await request('/manual-origins', {
  method: 'POST', body: originBody, key: originKey,
})).body, origin)
evidence.manualOriginId = origin.id
evidence.originDigest = origin.digest

const documentKey = randomUUID()
const documentBody = {
  origin: { kind: 'manual', manualOriginId: origin.id },
  model: '55', environment: 'simulation',
  establishmentId: fixture.establishmentId,
  series: fixture.series ?? 1,
}
const draft = (await request('/documents', {
  method: 'POST', body: documentBody, key: documentKey,
})).body
assert.equal(draft.id, (await request('/documents', {
  method: 'POST', body: documentBody, key: documentKey,
})).body.id)
evidence.documentId = draft.id

const ready = (await request(`/documents/${draft.id}/validate`, { method: 'POST' })).body
assert.equal(ready.document.status, 'ready')
evidence.calculationDigest = ready.resultDigest
evidence.reconciliationDigest = ready.reconciliationDigest
const issueKey = randomUUID()
const issue = await request(`/documents/${draft.id}/issue`, { method: 'POST', key: issueKey })
assert.equal(issue.status, 202)
assert.equal(issue.body.commandId, (await request(`/documents/${draft.id}/issue`, {
  method: 'POST', key: issueKey,
})).body.commandId)
evidence.issueCommandId = issue.body.commandId
const issued = await waitFor(draft.id, ['authorized', 'rejected'])
assert.equal(issued.status, 'authorized', 'The selected smoke scenario must authorize')
evidence.accessKey = issued.accessKey
evidence.signedXmlDigest = issued.signedXmlDigest
const issuanceResponses = []

async function verifyArtifacts(expected) {
  const listed = await request(`/documents/${draft.id}/artifacts`)
  assert.equal(listed.headers.get('cache-control'), 'private, no-store')
  assert.equal(listed.body.documentId, draft.id)
  const kinds = new Set(listed.body.artifacts.map((artifact) => artifact.kind))
  for (const kind of expected) assert.ok(kinds.has(kind), `Missing ${kind} artifact`)
  const digests = []
  for (const artifact of listed.body.artifacts) {
    assert.equal(artifact.simulated, true)
    const response = await fetch(
      `${baseUrl}/documents/${draft.id}/artifacts/${artifact.kind}?digest=${artifact.digest}`,
      { headers: { authorization }, signal: AbortSignal.timeout(20_000) },
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.length, artifact.byteSize)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.digest)
    if (artifact.kind === 'issuance_response') {
      const payload = JSON.parse(bytes.toString('utf8'))
      assert.equal(payload.simulated, true)
      assert.equal(payload.commandId, evidence.issueCommandId)
      issuanceResponses.push({
        digest: artifact.digest,
        scenario: payload.scenario,
        outcome: payload.outcome,
        requestDigest: payload.requestDigest,
      })
    }
    digests.push({ kind: artifact.kind, digest: artifact.digest, byteSize: bytes.length })
  }
  return digests
}

evidence.artifactsBeforeCancellation = await verifyArtifacts([
  'unsigned_xml', 'signed_xml', 'danfe', 'issuance_response', 'authorization_protocol',
])
evidence.issuanceResponses = [...issuanceResponses]
if (fixture.expectedIssueScenario) {
  assert.equal(fixture.expectedIssueScenario, 'timeout-after-accept')
  assert.deepEqual(new Set(issuanceResponses.map((item) => item.scenario)),
    new Set(['timeout-after-accept']))
  assert.deepEqual(new Set(issuanceResponses.map((item) => item.outcome)),
    new Set(['unknown', 'authorized']))
  assert.equal(new Set(issuanceResponses.map((item) => item.requestDigest)).size, 1)
}
const cancel = await request(`/documents/${draft.id}/cancellation-requests`, {
  method: 'POST', key: randomUUID(),
  body: { reason: 'Cancelamento solicitado na simulação local revisada' },
})
assert.equal(cancel.status, 202)
const cancelled = await waitFor(draft.id, ['cancelled', 'authorized'])
assert.equal(cancelled.status, 'cancelled', 'The selected smoke scenario must cancel')
evidence.artifactsAfterCancellation = await verifyArtifacts([
  'cancellation_request', 'cancellation_response', 'cancellation_protocol',
])
evidence.transitions = (await request(`/documents/${draft.id}/transitions`)).body.transitions
assert.ok(evidence.transitions.length >= 5)
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
