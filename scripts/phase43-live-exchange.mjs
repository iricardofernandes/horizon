#!/usr/bin/env node
/** One explicitly configured live SP homologation exchange; never logs authority references. */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { phase43LiveSummary } from './lib/phase43-live-summary.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const action = process.env.PHASE43_ACTION
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for the live homologation job`)
  return value
}
const identifier = (name) => {
  const value = required(name)
  if (!uuid.test(value)) throw new Error(`${name} must be a UUID`)
  return value
}

if (!['resume', 'consult', 'status'].includes(action))
  throw new Error('PHASE43_ACTION must be resume, consult or status')

const args = [
  join(root, 'fiscal/dist/phase43-exchange-resume-cli.js'),
  '--action',
  action,
  '--tenant',
  identifier('PHASE43_TENANT_ID'),
  '--exchange',
  identifier('PHASE43_EXCHANGE_ID'),
  '--actor',
  required('PHASE43_ACTOR_ID'),
  '--worker',
  required('PHASE43_WORKER_ID'),
  '--trust-anchor',
  required('PHASE43_TRUST_ANCHOR_PATH'),
  '--trust-anchor-fingerprint',
  required('PHASE43_TRUST_ANCHOR_FINGERPRINT'),
  '--operations',
  required('PHASE43_OPERATIONS_PATH'),
  '--endpoints',
  required('PHASE43_ENDPOINTS_PATH'),
  '--document-response-schema',
  required('PHASE43_DOCUMENT_RESPONSE_SCHEMA_PATH'),
  '--consultation-response-schema',
  required('PHASE43_CONSULTATION_RESPONSE_SCHEMA_PATH'),
]
if (action === 'consult' || action === 'status')
  args.push('--document', identifier('PHASE43_DOCUMENT_ID'))
if (action === 'status') args.push('--grant', identifier('PHASE43_GRANT_ID'))

for (const name of [
  'DATABASE_URL',
  'FISCAL_ARTIFACT_KEY_HEX',
  'FISCAL_ARTIFACT_BUCKET',
  'FISCAL_ARTIFACT_REGION',
]) required(name)

const result = spawnSync(process.execPath, args, {
  cwd: join(root, 'fiscal'),
  env: process.env,
  encoding: 'utf8',
  timeout: 120_000,
  maxBuffer: 1024 * 1024,
})
if (result.status !== 0) {
  // The operator inspects the retained ledger and runner diagnostics. Raw CLI output
  // may contain receipt or protocol references, so neither stream enters Actions logs.
  throw new Error(`Live homologation exchange failed (exit ${result.status ?? 'unknown'})`)
}
let observed
try {
  observed = JSON.parse(result.stdout)
} catch {
  throw new Error('Live homologation exchange returned an invalid summary')
}
process.stdout.write(`${JSON.stringify(phase43LiveSummary(observed))}\n`)
