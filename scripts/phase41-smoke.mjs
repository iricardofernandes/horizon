#!/usr/bin/env node

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

const tenantId = flag('tenant')
if (!tenantId) {
  console.error('usage: node scripts/phase41-smoke.mjs --tenant <uuid> [--document <uuid>]')
  process.exit(2)
}

const baseUrl = flag('base-url', 'http://localhost:8000/fiscal')
const documentId = flag('document', randomUUID())
const subjectId = flag('subject', randomUUID())
const expectExplanation = args.includes('--expect-explanation')
const token = execFileSync(
  process.execPath,
  [
    join(root, 'infra/scripts/mint-dev-token.mjs'),
    '--tenant',
    tenantId,
    '--sub',
    subjectId,
    '--role',
    'fiscal:admin',
  ],
  { encoding: 'utf8' },
).trim()
const headers = { authorization: `Bearer ${token}` }

const before = databaseSnapshot()
const previewInput = {
  schemaVersion: 1,
  // Fixed fixture IDs keep the canonical digest repeatable for the same tenant while
  // the deliberately wrong body tenant also proves that the token tenant wins.
  tenantId: '00000000-0000-4000-8000-000000000001',
  issuerEstablishmentId: '00000000-0000-4000-8000-000000000002',
  model: '55',
  environment: 'simulation',
  operation: 'phase41-smoke-unsupported',
  purpose: 'normal',
  issuer: { regime: 'normal', stateCode: '35', municipalityCode: '3550308' },
  recipient: {
    regime: 'normal',
    stateCode: '35',
    municipalityCode: '3550308',
    taxpayer: true,
  },
  origin: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
  destination: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
  issueDate: '2026-09-22',
  currency: 'BRL',
  lines: [
    {
      id: '00000000-0000-4000-8000-000000000003',
      itemId: '00000000-0000-4000-8000-000000000004',
      quantity: '1',
      unitPrice: '10',
      discount: { amount: '0', currency: 'BRL' },
      charges: { amount: '0', currency: 'BRL' },
      classifications: { ncm: '99999999' },
      taxFacts: {},
    },
  ],
}

const preview = await fetch(`${baseUrl}/calculations/preview`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(previewInput),
})
const previewBody = await preview.json()
assert.equal(preview.status, 422)
assert.equal(preview.headers.get('cache-control'), 'private, no-store')
assert.equal(previewBody.supported, false)
assert.ok(
  ['UNSUPPORTED_RULE', 'MISSING_CLASSIFICATION'].includes(previewBody.code),
  `unexpected unsupported preview code: ${previewBody.code}`,
)
assert.match(previewBody.inputDigest, /^[0-9a-f]{64}$/)

const explanation = await fetch(`${baseUrl}/documents/${documentId}/calculation/explanation`, {
  headers,
})
const explanationBody = await explanation.json()
if (expectExplanation) {
  assert.equal(explanation.status, 200)
  assert.equal(explanationBody.documentId, documentId)
  assert.match(explanationBody.inputDigest, /^[0-9a-f]{64}$/)
  assert.match(explanationBody.rulesDigest, /^[0-9a-f]{64}$/)
  assert.match(explanationBody.resultDigest, /^[0-9a-f]{64}$/)
  assert.ok(explanationBody.explanation?.templateVersion)
} else {
  assert.equal(explanation.status, 404)
}

const blocked = {}
for (const action of ['validate', 'issue']) {
  const response = await fetch(`${baseUrl}/documents/${documentId}/${action}`, {
    method: 'POST',
    headers,
  })
  const body = await response.json()
  assert.equal(response.status, 409)
  assert.equal(body.detail, 'No Fiscal authority capability is enabled')
  blocked[action] = { status: response.status, detail: body.detail }
}

const after = databaseSnapshot()
assert.deepEqual(after, before, 'Phase 41 HTTP smoke changed Fiscal database row counts')

process.stdout.write(
  `${JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      baseUrl,
      tenantId,
      preview: {
        status: preview.status,
        code: previewBody.code,
        inputDigest: previewBody.inputDigest,
        cacheControl: preview.headers.get('cache-control'),
      },
      explanation: {
        status: explanation.status,
        ...(expectExplanation
          ? { resultDigest: explanationBody.resultDigest }
          : { detail: explanationBody.detail }),
      },
      blocked,
      databaseCountsBefore: before,
      databaseCountsAfter: after,
    },
    null,
    2,
  )}\n`,
)

function databaseSnapshot() {
  const sql = `select json_build_object(
    'documents', (select count(*) from fiscal_documents),
    'calculations', (select count(*) from fiscal_calculations),
    'bindings', (select count(*) from fiscal_document_calculation_bindings),
    'transitions', (select count(*) from fiscal_transitions),
    'outbox', (select count(*) from fiscal_outbox),
    'numberReservations', (select count(*) from fiscal_number_reservations),
    'authorityAttempts', (select count(*) from authority_attempts),
    'authorityResponses', (select count(*) from authority_responses),
    'auditEntries', (select count(*) from fiscal_audit_entries)
  );`
  const output = execFileSync(
    'docker',
    [
      'exec',
      'horizon-postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'horizon_fiscal',
      '-Atc',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim()
  return JSON.parse(output)
}
