// Creates the synthetic probe's own account in the demo workspace, or grants it what it lacks
// (Phase 70). Signs in as the demo owner through the gateway; safe to run again.
//   node scripts/probe-user.mjs    (make probe-user)
const BASE = process.env.HORIZON_API_URL ?? 'http://localhost:8000'
const OWNER = {
  email: process.env.HORIZON_DEMO_EMAIL ?? 'demo@horizon.local',
  password: process.env.HORIZON_DEMO_PASSWORD ?? 'Horizon-demo-2026!',
}
const PROBE = {
  email: process.env.PROBE_EMAIL ?? 'probe@horizon.local',
  password: process.env.PROBE_PASSWORD ?? 'Horizon-probe-2026!',
}
const ROLES = [
  { module: 'procurement', role: 'buyer' },
  { module: 'reporting', role: 'viewer' },
]

async function call(path, { method = 'GET', body, bearer } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  const parsed = text ? JSON.parse(text) : null
  return { status: response.status, body: parsed }
}

function must(answer, statuses, what) {
  if (!statuses.includes(answer.status))
    throw new Error(`${what} answered ${answer.status}: ${JSON.stringify(answer.body)}`)
  return answer.body
}

const login = must(
  await call('/auth/login', { method: 'POST', body: OWNER }),
  [200],
  'signing in as the demo owner',
)
const tenantId = process.env.PROBE_TENANT_ID ?? login.workspaces[0].tenantId
const session = must(
  await call('/auth/workspace', {
    method: 'POST',
    body: { selectionToken: login.selectionToken, tenantId },
  }),
  [200],
  'entering the workspace',
)
const bearer = session.accessToken

try {
  const created = await call('/identity/users', {
    method: 'POST',
    bearer,
    body: { email: PROBE.email, name: 'Synthetic probe', password: PROBE.password, roles: ROLES },
  })
  if (created.status !== 409) {
    must(created, [200, 201], 'creating the probe account')
    process.stdout.write(`created ${PROBE.email} in ${tenantId}\n`)
  } else {
    let cursor
    let user
    do {
      const page = must(
        await call(`/identity/users?limit=100${cursor ? `&cursor=${cursor}` : ''}`, { bearer }),
        [200],
        'listing users',
      )
      user = page.data.find((entry) => entry.email === PROBE.email)
      cursor = page.page.nextCursor
    } while (!user && cursor)
    if (!user) throw new Error(`${PROBE.email} exists but is not listed`)
    for (const assignment of ROLES)
      must(
        await call(`/identity/users/${user.id}/roles`, {
          method: 'POST',
          bearer,
          body: { assignment, operation: 'grant' },
        }),
        [200, 409],
        `granting ${assignment.module}:${assignment.role}`,
      )
    process.stdout.write(`${PROBE.email} already exists in ${tenantId}; roles granted\n`)
  }
} finally {
  await call('/auth/logout', { method: 'POST', bearer, body: { familyId: session.familyId } })
}
