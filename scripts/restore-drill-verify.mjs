#!/usr/bin/env node
/**
 * Verifies the stack scripts/restore-drill.sh restored, and stores the evidence (ADR 0063).
 * Run by the drill, with its facts in the environment; it can also be run by hand against a
 * stack kept with --keep.
 *
 * Checks, all against the drill's own gateway (port 18000) and stores:
 *   - the point in time: the marker written before the target is there, the one after is not,
 *     in PostgreSQL and in the object store;
 *   - the RPO: at most 5 minutes of WAL can be lost, and the last archived segment was recent;
 *   - every module's audit chain, for every tenant with an audit log, judges the same as live;
 *   - the consistency checks run, and a balance broken on purpose (in the drill only) is caught;
 *   - a synthetic sign-in of the demo user;
 *   - the RTO: from the failure to a verified stack.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = process.env
const RUN = env.DRILL_RUN
const TARGET = env.DRILL_TARGET
const PREFIX = env.DRILL_PREFIX ?? 'horizon-drill'
const DRILL = 'http://localhost:18000'
const LIVE = 'http://localhost:8000'
const RPO_SECONDS = 900
const RTO_SECONDS = 3600
const AUDITED = ['identity', 'catalog', 'sales', 'financial', 'treasury', 'ledger', 'procurement', 'inventory', 'fiscal', 'crm', 'reporting', 'files']
const AUDIT_DATABASES = {
  identity: 'audit_log', catalog: 'audit_log', sales: 'audit_log', financial: 'audit_log',
  treasury: 'audit_log', ledger: 'audit_log', procurement: 'audit_log', inventory: 'audit_log',
  fiscal: 'fiscal_audit_entries', crm: 'audit_log', reporting: 'audit_log', files: 'audit_log',
}
const checks = []
const check = (name, passed, evidence) => {
  checks.push({ name, passed, evidence })
  console.log(`${passed ? '✓' : '✗'} ${name}`, JSON.stringify(evidence))
}

const timings = Object.fromEntries(
  readFileSync(env.DRILL_TIMINGS, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(' '))
    .map(([step, at]) => [step, Number(at)]),
)
const drillSql = (database, query) =>
  execFileSync('docker', ['exec', `${PREFIX}-postgres`, 'psql', '-U', 'postgres', '-d', database, '-At', '-c', query], {
    encoding: 'utf8',
  }).trim()

function token(tenant, roles) {
  return execFileSync(
    process.execPath,
    [join(root, 'infra/scripts/mint-dev-token.mjs'), '--tenant', tenant, '--sub', `drill-${RUN}`, ...roles.flatMap((role) => ['--role', role])],
    { encoding: 'utf8' },
  ).trim()
}
const AUDITORS = [...AUDITED.filter((module) => module !== 'files').map((module) => `${module}:auditor`)]

async function call(base, path, bearer, { method = 'GET', body, key } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed }
}

// --- the point in time -----------------------------------------------------------------------
const markers = drillSql('horizon_drill', `select label from markers where run = '${RUN}' order by written_at`)
const beforeWritten = drillSql('horizon_drill', `select written_at from markers where run = '${RUN}' and label = 'before'`)
const objects = execFileSync('docker', [
  'run', '--rm', '--network', 'horizon', '-e', 'U', '-e', 'S', '--entrypoint', '/bin/sh',
  execFileSync('docker', ['inspect', 'horizon-minio-init-1', '--format', '{{.Config.Image}}'], { encoding: 'utf8' }).trim(),
  '-ec',
  `mc alias set drill http://${PREFIX}-minio:9000 "$U" "$S" >/dev/null
   mc stat drill/horizon-exports/drill/${RUN}/before >/dev/null 2>&1 && echo before || true
   mc stat drill/horizon-exports/drill/${RUN}/after >/dev/null 2>&1 && echo after || true`,
], {
  encoding: 'utf8',
  env: {
    ...process.env,
    U: execFileSync('docker', ['exec', 'horizon-minio', 'printenv', 'MINIO_ROOT_USER'], { encoding: 'utf8' }).trim(),
    S: execFileSync('docker', ['exec', 'horizon-minio', 'printenv', 'MINIO_ROOT_PASSWORD'], { encoding: 'utf8' }).trim(),
  },
}).trim().split('\n').filter(Boolean)
check('the restore lands on the target: what was written before it is there, what came after is not', markers === 'before' && objects.join() === 'before', {
  target: TARGET,
  rows: markers.split('\n').filter(Boolean),
  objects,
  lastReplayedCommit: env.DRILL_REPLAYED || null,
  beforeMarkerWritten: beforeWritten,
})

// --- the RPO ---------------------------------------------------------------------------------
const archiver = JSON.parse(env.DRILL_ARCHIVER)
// archive_timeout arrives as an interval, `00:05:00`.
const archiveTimeoutSeconds = String(archiver.archiveTimeoutSeconds)
  .split(':')
  .reduce((sum, part) => sum * 60 + Number(part), 0)
const lastArchivedAge = (timings.failure - new Date(archiver.lastArchivedAt).getTime()) / 1000
const replayGap = env.DRILL_REPLAYED
  ? (new Date(TARGET).getTime() - new Date(env.DRILL_REPLAYED).getTime()) / 1000
  : null
check('the point-in-time target lands inside the RPO', archiveTimeoutSeconds > 0 && archiveTimeoutSeconds <= RPO_SECONDS && lastArchivedAge <= RPO_SECONDS && archiver.failedCount === 0 && replayGap !== null && replayGap >= 0 && replayGap <= RPO_SECONDS, {
  rpoSeconds: RPO_SECONDS,
  worstCaseLossSeconds: archiveTimeoutSeconds,
  lastArchivedSegmentAgeAtFailureSeconds: Math.round(lastArchivedAge),
  targetMinusLastReplayedCommitSeconds: replayGap,
  archiver,
})

// --- every audit chain, live against restored ------------------------------------------------
const tenantsByModule = {}
const tenants = new Set()
for (const module of AUDITED) {
  const table = AUDIT_DATABASES[module]
  const found = drillSql(`horizon_${module}`, `select distinct tenant_id from ${table}`).split('\n').filter(Boolean)
  tenantsByModule[module] = new Set(found)
  for (const tenant of found) tenants.add(tenant)
}
async function chain(base, bearer, module) {
  const broken = []
  let checked = 0
  let cursor = null
  for (let page = 0; page < 1000; page += 1) {
    const answer = await call(base, `/${module}/audit?limit=200${cursor ? `&cursor=${cursor}` : ''}`, bearer)
    if (answer.status !== 200) return { status: answer.status, checked, broken }
    checked += answer.body.data.length
    broken.push(...answer.body.chain.broken)
    cursor = answer.body.page.nextCursor
    if (!cursor) break
  }
  return { status: 200, checked, broken: broken.sort((a, b) => a - b) }
}
const differing = []
const brokenInBoth = []
let chainsCompared = 0
let rowsChecked = 0
const queue = [...tenants]
async function worker() {
  for (let tenant = queue.shift(); tenant; tenant = queue.shift()) {
    const bearer = token(tenant, [...AUDITORS, 'identity:auditor'])
    for (const module of AUDITED) {
      if (!tenantsByModule[module].has(tenant)) continue
      const [restored, live] = await Promise.all([chain(DRILL, bearer, module), chain(LIVE, bearer, module)])
      chainsCompared += 1
      rowsChecked += restored.checked
      const same =
        restored.status === 200 &&
        live.status === 200 &&
        JSON.stringify(restored.broken) === JSON.stringify(live.broken)
      if (!same) differing.push({ tenant, module, restored, live: { status: live.status, checked: live.checked, broken: live.broken } })
      else if (restored.broken.length) brokenInBoth.push({ tenant, module, broken: restored.broken })
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker))
check('every audit chain of every tenant judges the same restored as live', differing.length === 0 && chainsCompared > 0, {
  tenants: tenants.size,
  chainsCompared,
  rowsChecked,
  differing: differing.slice(0, 5),
  // Rows tampered on purpose by earlier drills (Phase 68); the restore keeps the evidence.
  knownBroken: brokenInBoth,
})

// --- consistency checks, and a balance broken on purpose -------------------------------------
const [candidate] = drillSql('horizon_ledger', `
  select m.tenant_id || ' ' || m.account_id || ' ' || a.currency || ' ' || other.id
  from account_mappings m
  join accounts a on a.tenant_id = m.tenant_id and a.id = m.account_id
  join lateral (
    select o.id from accounts o
    where o.tenant_id = m.tenant_id and o.currency = a.currency and o.postable and o.active
      and o.id <> m.account_id and o.type in ('revenue', 'equity', 'liability')
    order by o.code limit 1
  ) other on true
  where m.role = 'receivables'
  limit 1`).split('\n').filter(Boolean)
if (!candidate) {
  check('a deliberately broken balance is caught by the consistency check', false, { reason: 'no tenant maps a receivables control account' })
} else {
  const [tenant, receivables, currency, other] = candidate.split(' ')
  const bearer = token(tenant, ['reporting:admin', 'ledger:admin', 'financial:viewer', 'treasury:viewer', 'inventory:viewer', ...AUDITORS, 'identity:auditor'])
  const before = await call(DRILL, '/reporting/consistency-checks', bearer, { method: 'POST' })
  const amount = '12345'
  const posted = await call(DRILL, '/ledger/transactions', bearer, {
    method: 'POST',
    key: `drill-${RUN}`,
    body: {
      reference: `DRILL-${RUN}`.slice(0, 60),
      postedOn: new Date().toISOString().slice(0, 10),
      currency,
      memo: 'Phase 69 restore drill: a balance broken on purpose, in the drill copy only',
      lines: [
        { accountId: receivables, side: 'debit', amount },
        { accountId: other, side: 'credit', amount },
      ],
    },
  })
  const after = await call(DRILL, '/reporting/consistency-checks', bearer, { method: 'POST' })
  const control = (run) => run.body?.checks?.find((entry) => entry.check === 'receivables-control')
  const gap = (run) => {
    const found = control(run)?.differences?.find((difference) => difference.key === currency)
    return found ? BigInt(found.ledger) - BigInt(found.owner) : 0n
  }
  const caught = before.status === 201 && posted.status === 201 && after.status === 201 && control(after)?.outcome === 'differences' && gap(after) - gap(before) === BigInt(amount)
  // The posting must exist in the drill's copy, and never in the live ledger.
  const reference = `DRILL-${RUN}`.slice(0, 60)
  const inDrill = drillSql('horizon_ledger', `select count(*) from transactions where reference = '${reference}'`)
  const inLive = execFileSync('docker', ['exec', 'horizon-postgres', 'psql', '-U', 'postgres', '-d', 'horizon_ledger', '-At', '-c', `select count(*) from transactions where reference = '${reference}'`], { encoding: 'utf8' }).trim()
  check('the drill writes only to its own copy', inDrill === '1' && inLive === '0', { reference, inDrill: Number(inDrill), inLive: Number(inLive) })
  check('a deliberately broken balance is caught by the consistency check', caught, {
    tenant,
    before: { status: before.status, outcome: before.body?.outcome, receivables: control(before) },
    postedToReceivables: { status: posted.status, amount, currency },
    after: { status: after.status, outcome: after.body?.outcome, receivables: control(after) },
    checks: after.body?.checks?.map((entry) => ({ check: entry.check, outcome: entry.outcome })),
  })
}

// --- a synthetic sign-in -----------------------------------------------------------------------
const login = await call(DRILL, '/auth/login', null, {
  method: 'POST',
  body: { email: 'demo@horizon.local', password: process.env.HORIZON_DEMO_PASSWORD ?? 'Horizon-demo-2026!' },
})
let signedIn = { login: login.status }
if (login.status === 200 && login.body.workspaces?.length) {
  const workspace = await call(DRILL, '/auth/workspace', null, {
    method: 'POST',
    body: { selectionToken: login.body.selectionToken, tenantId: login.body.workspaces[0].tenantId },
  })
  const me = await call(DRILL, '/identity/me', workspace.body?.accessToken)
  const items = await call(DRILL, '/catalog/items?limit=1', workspace.body?.accessToken)
  signedIn = { login: login.status, workspace: workspace.status, me: me.status, catalogItems: items.status }
}
check('the demo user signs in to the restored stack and reads it', signedIn.me === 200 && signedIn.catalogItems === 200, signedIn)

// --- the RTO, and the record -----------------------------------------------------------------
const verifiedAt = Date.now()
const rtoSeconds = Math.round((verifiedAt - timings.failure) / 1000)
check('the stack is restored and verified within the RTO', rtoSeconds <= RTO_SECONDS, {
  rtoSeconds: RTO_SECONDS,
  measuredSeconds: rtoSeconds,
  steps: {
    restorePostgresSeconds: Math.round((timings['restore-objects'] - timings['restore-postgres']) / 1000),
    restoreObjectsSeconds: Math.round((timings['start-stack'] - timings['restore-objects']) / 1000),
    startStackSeconds: Math.round((timings['stack-ready'] - timings['start-stack']) / 1000),
    verifySeconds: Math.round((verifiedAt - timings['stack-ready']) / 1000),
  },
})

const passed = checks.every((entry) => entry.passed)
const record = {
  drill: 'phase69-restore',
  adr: '0063',
  run: RUN,
  startedAt: new Date(timings.backup).toISOString(),
  failedAt: new Date(timings.failure).toISOString(),
  verifiedAt: new Date(verifiedAt).toISOString(),
  objectives: { rpoSeconds: RPO_SECONDS, rtoSeconds: RTO_SECONDS },
  baseBackup: JSON.parse(env.DRILL_BACKUP),
  baseBackupIntervalSeconds: Number(env.DRILL_INTERVAL),
  buckets: JSON.parse(env.DRILL_BUCKETS || '{}'),
  passed,
  checks,
}
const path = join(root, 'docs', 'drills', `${new Date(timings.backup).toISOString().slice(0, 10)}-phase69-restore-drill.json`)
await mkdir(dirname(path), { recursive: true })
await writeFile(path, `${JSON.stringify(record, null, 2)}\n`)
console.log(`${passed ? 'drill passed' : 'drill FAILED'}; results in ${path}`)
process.exitCode = passed ? 0 : 1
