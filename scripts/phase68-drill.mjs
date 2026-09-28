#!/usr/bin/env node
/**
 * Phase 68 controls drill, against the local stack through Kong (ADR 0062). With a transfer
 * over the workspace's threshold in Treasury, it proves:
 *   1. the treasury.transfer pair is refused with the shared 403 `segregation-of-duties`;
 *   2. a member without the approval is refused, and allowed through a valid delegation,
 *      the approval recording both names;
 *   3. a revoked delegation no longer works;
 *   4. a tampered audit row is reported as a broken chain by `GET /treasury/audit`.
 * It stores its results in docs/drills/, and exits non-zero if any check failed.
 *
 *   node scripts/phase68-drill.mjs [--base-url http://localhost:8000]
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
const startedAt = new Date()
const checks = []
const tenantId = randomUUID()

/** A development token for one person of the drill's workspace. */
function tokenFor(subject, ...roles) {
  return execFileSync(
    process.execPath,
    [
      join(root, 'infra/scripts/mint-dev-token.mjs'),
      '--tenant',
      tenantId,
      '--sub',
      subject,
      ...roles.flatMap((role) => ['--role', role]),
    ],
    { encoding: 'utf8' },
  ).trim()
}

const people = {
  treasurer: { id: randomUUID(), role: 'treasury:admin' },
  clerk: { id: randomUUID(), role: 'treasury:operator' },
  standIn: { id: randomUUID(), role: 'treasury:viewer' },
}
const tokens = Object.fromEntries(
  Object.entries(people).map(([name, person]) => [name, tokenFor(person.id, person.role)]),
)

async function call(path, { method = 'GET', body, as } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tokens[as]}`,
      'idempotency-key': randomUUID(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
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

function check(name, passed, evidence) {
  checks.push({ name, passed, evidence })
  console.log(`${passed ? '✓' : '✗'} ${name}`, JSON.stringify(evidence))
}

// --- the workspace: two accounts and a threshold of 1,000.00 -------------------------------
const account = (name, opening) =>
  ok('/treasury/accounts', {
    method: 'POST',
    as: 'treasurer',
    body: {
      kind: 'bank',
      name,
      currency: 'BRL',
      bank: { bankCode: '001', branch: '1234-5', accountNumber: '98765-0' },
      openedOn: '2026-09-01',
      openingBalance: { amount: opening, direction: 'inflow' },
    },
  })
const main = await account('Drill main', '5000000')
const reserve = await account('Drill reserve', '0')
await ok('/treasury/approval-policies', {
  method: 'PUT',
  as: 'treasurer',
  body: { currency: 'BRL', threshold: '100000' },
})
const transfer = (amount) =>
  ok('/treasury/transfers', {
    method: 'POST',
    as: 'clerk',
    body: {
      fromAccountId: main.id,
      toAccountId: reserve.id,
      amount,
      currency: 'BRL',
      valueOn: '2026-09-28',
    },
  })

// --- 1. the pair is refused, with the shared answer ------------------------------------------
const waiting = await transfer('250000')
const clerkWithRole = tokenFor(people.clerk.id, 'treasury:admin')
tokens.clerkAsAdmin = clerkWithRole
const own = await call(`/treasury/transfers/${waiting.id}/approve`, {
  method: 'POST',
  as: 'clerkAsAdmin',
})
check(
  'the treasury.transfer pair is refused with the shared code',
  waiting.status === 'pending' &&
    own.status === 403 &&
    own.body?.code === 'segregation-of-duties' &&
    own.body?.pair === 'treasury.transfer',
  { transferStatus: waiting.status, status: own.status, code: own.body?.code, pair: own.body?.pair },
)

// --- 2. refused without the approval, allowed through a delegation --------------------------
const before = await call(`/treasury/transfers/${waiting.id}/approve`, {
  method: 'POST',
  as: 'standIn',
})
const delegation = await ok('/treasury/delegations', {
  method: 'POST',
  as: 'treasurer',
  body: {
    permission: 'treasury:transfer:approve',
    delegateId: people.standIn.id,
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    reason: 'Phase 68 drill',
  },
})
const after = await call(`/treasury/transfers/${waiting.id}/approve`, {
  method: 'POST',
  as: 'standIn',
})
const listed = await ok('/treasury/transfers?limit=10', { as: 'treasurer' })
const approved = listed.data.find((row) => row.id === waiting.id)
check(
  'a member is refused without the approval, and allowed through a valid delegation',
  before.status === 403 &&
    before.body?.code === undefined &&
    after.status === 200 &&
    approved?.status === 'posted' &&
    approved?.decidedBy === people.standIn.id &&
    approved?.decidedFor === people.treasurer.id,
  {
    withoutDelegation: before.status,
    withDelegation: after.status,
    decidedBy: approved?.decidedBy === people.standIn.id ? 'stand-in' : approved?.decidedBy,
    decidedFor: approved?.decidedFor === people.treasurer.id ? 'treasurer' : approved?.decidedFor,
  },
)

// --- 3. a revoked delegation no longer works ------------------------------------------------
await ok(`/treasury/delegations/${delegation.id}/revoke`, { method: 'POST', as: 'treasurer' })
const next = await transfer('300000')
const revoked = await call(`/treasury/transfers/${next.id}/approve`, {
  method: 'POST',
  as: 'standIn',
})
const delegations = await ok('/treasury/delegations', { as: 'treasurer' })
check(
  'a revoked delegation no longer works',
  revoked.status === 403 && delegations.data[0]?.status === 'revoked',
  { status: revoked.status, delegation: delegations.data[0]?.status },
)

// --- 4. a tampered audit row shows as a broken chain ----------------------------------------
const intact = await ok('/treasury/audit?limit=100', { as: 'treasurer' })
const approval = intact.data.find((entry) => entry.action === 'transfer.approved')
execFileSync('docker', [
  'exec', 'horizon-postgres', 'psql', '-U', 'postgres', '-d', 'horizon_treasury', '-v', 'ON_ERROR_STOP=1',
  '-c', 'set session_replication_role = replica',
  '-c', `update audit_log set details = details || '{"amount": "1"}'::jsonb
    where tenant_id = '${tenantId}' and sequence = ${approval.sequence}`,
])
const tampered = await ok('/treasury/audit?limit=100', { as: 'treasurer' })
const byOperator = await call('/treasury/audit', { as: 'clerk' })
check(
  'a tampered audit row is reported as a broken chain',
  intact.chain.status === 'intact' &&
    approval?.details?.onBehalfOf === people.treasurer.id &&
    tampered.chain.status === 'broken' &&
    tampered.chain.broken.includes(approval.sequence) &&
    byOperator.status === 403,
  {
    before: intact.chain,
    after: tampered.chain,
    tamperedSequence: approval?.sequence,
    readByOperator: byOperator.status,
  },
)

// --- the record ------------------------------------------------------------------------------
const passed = checks.every((entry) => entry.passed)
const record = {
  drill: 'phase68-controls',
  adr: '0062',
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  baseUrl,
  tenantId,
  passed,
  checks,
}
const path = join(root, 'docs', 'drills', `${startedAt.toISOString().slice(0, 10)}-phase68-controls-drill.json`)
await mkdir(dirname(path), { recursive: true })
await writeFile(path, `${JSON.stringify(record, null, 2)}\n`)
console.log(`${passed ? 'drill passed' : 'drill FAILED'}; results in ${path}`)
process.exitCode = passed ? 0 : 1
