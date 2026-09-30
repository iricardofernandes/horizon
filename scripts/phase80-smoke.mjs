#!/usr/bin/env node
/**
 * Phase 80 smoke, against the local stack: the web and the gateway.
 *   1. Kong limits each browser by its own address: two browsers reach the web server from
 *      two addresses; one spends the sign-in limit, the other is not affected, and forging
 *      `X-Forwarded-For` does not buy the first a new allowance.
 *   2. Every page carries a content security policy with a fresh nonce, and the headers that
 *      forbid sniffing and framing.
 *   3. A write to the web's API that another site started is refused with 403.
 *   4. A person with Catalog and no Inventory role reads Catalog, and Inventory refuses
 *      them, which the items screen now does without.
 *   5. Writes right after signup, in the modules that provision from Identity's event, are
 *      never a 500.
 * The two browsers are throwaway containers on the web's network (`horizon-edge`), so they
 * need Docker. Results go to docs/drills/; non-zero on failure.
 *
 *   node scripts/phase80-smoke.mjs [--base-url http://localhost:8000] [--web http://localhost:3000]
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { flagOf, kit } from './phase-n-kit.mjs'

const args = process.argv.slice(2)
const baseUrl = flagOf(args, 'base-url', 'http://localhost:8000').replace(/\/$/, '')
const web = flagOf(args, 'web', 'http://localhost:3000').replace(/\/$/, '')
const k = kit({ baseUrl, label: 'phase80' })
const startedAt = new Date()
const today = startedAt.toISOString().slice(0, 10)
const SIGN_IN_LIMIT = 30

/**
 * A browser at the address given: a container on the web's network signs in `times`
 * times with a wrong password, and reports each status.
 */
function browser(address, times, forged) {
  const script = `
    const statuses = []
    for (let i = 0; i < ${times}; i++) {
      const response = await fetch('http://web:3000/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json'${forged ? `, 'x-forwarded-for': '${forged}'` : ''} },
        body: JSON.stringify({ email: 'nobody.phase80@horizon.local', password: 'not-the-password-80' }),
      })
      statuses.push(response.status)
    }
    console.log(JSON.stringify(statuses))`
  const output = execFileSync(
    'docker',
    ['run', '--rm', '--network', 'horizon-edge', '--ip', address, '--add-host', `web:${webAddress()}`, 'node:24-alpine', 'node', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 120_000 },
  )
  return JSON.parse(output.trim().split('\n').at(-1))
}

function webAddress() {
  return execFileSync('docker', ['inspect', 'horizon-web', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'], {
    encoding: 'utf8',
  }).trim()
}

const count = (statuses, status) => statuses.filter((value) => value === status).length

async function run() {
  // 1. Limits per browser.
  // Two addresses of the web's network that neither Kong (.5) nor the web (.6) holds.
  const first = browser('10.213.80.2', SIGN_IN_LIMIT + 2)
  const forged = browser('10.213.80.2', 2, `198.51.100.${1 + Math.floor(Math.random() * 200)}`)
  const second = browser('10.213.80.3', 1)
  k.check(
    'one browser spending its sign-in limit leaves another untouched, and forging X-Forwarded-For buys nothing',
    count(first, 429) >= 1 && first[0] === 401 && forged.every((status) => status === 429) && second[0] === 401,
    { first: { refused: count(first, 401), limited: count(first, 429) }, forged, second },
  )

  // 2. Headers.
  const pages = await Promise.all([fetch(`${web}/login`), fetch(`${web}/login`)])
  const policies = pages.map((page) => page.headers.get('content-security-policy') ?? '')
  const nonces = policies.map((policy) => /'nonce-([^']+)'/.exec(policy)?.[1])
  const [page] = pages
  k.check(
    'every page has a content security policy with a fresh nonce, and cannot be sniffed or framed',
    nonces.every(Boolean) &&
      nonces[0] !== nonces[1] &&
      policies[0].includes("frame-ancestors 'none'") &&
      !/script-src[^;]*unsafe-inline/.test(policies[0]) &&
      page.headers.get('x-content-type-options') === 'nosniff' &&
      page.headers.get('x-frame-options') === 'DENY' &&
      page.headers.get('referrer-policy') === 'strict-origin-when-cross-origin' &&
      !page.headers.has('x-powered-by'),
    { policy: policies[0], freshNonce: nonces[0] !== nonces[1] },
  )

  // 3. Cross-site writes.
  const attempt = (headers) =>
    fetch(`${web}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{}',
    }).then((response) => response.status)
  const crossSite = await attempt({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })
  const foreignOrigin = await attempt({ origin: 'https://evil.example' })
  const sameOrigin = await attempt({ 'sec-fetch-site': 'same-origin', origin: web })
  k.check(
    'a write another site started is refused with 403; the same origin reaches the route',
    crossSite === 403 && foreignOrigin === 403 && sameOrigin === 400,
    { crossSite, foreignOrigin, sameOrigin },
  )

  // 4. Catalog without Inventory.
  const owner = await k.workspace('a', [])
  const reader = await k.person(owner, 'Leitor Catalogo', [{ module: 'catalog', role: 'viewer' }])
  const items = await k.call('/catalog/items?limit=5', { token: reader.token })
  const warehouses = await k.call('/inventory/warehouses', { token: reader.token })
  k.check(
    'a person with Catalog and no Inventory reads the items, and Inventory refuses the stock the screen does without',
    items.status === 200 && warehouses.status === 403,
    { items: items.status, warehouses: warehouses.status },
  )

  // 5. Writes right after signup, asked once each, with no retry.
  const fresh = await k.workspace('b', ['catalog', 'sales', 'inventory'])
  const once = (path, body) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fresh.token}`,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    }).then((response) => ({ status: response.status, retryAfter: response.headers.get('retry-after') }))
  const writes = {
    catalog: await once('/catalog/units', { code: `U${randomBytes(2).toString('hex')}`, name: 'Unidade', decimalPlaces: 0 }),
    inventory: await once('/inventory/warehouses', { name: 'Depósito 80' }),
  }
  k.check(
    'writes right after signup are served, or asked to wait with Retry-After, never a 500',
    Object.values(writes).every(
      (write) => write.status < 300 || (write.status === 503 && write.retryAfter) || write.status === 422,
    ) && Object.values(writes).every((write) => write.status !== 500),
    writes,
  )
}

try {
  await run()
} catch (error) {
  k.check('the smoke ran to the end', false, String(error).slice(0, 300))
}
const passed = k.checks.every((entry) => entry.passed)
const file = await k.store(`${today}-phase80-web-gateway-smoke.json`, {
  phase: 80,
  kind: 'web-gateway-smoke',
  baseUrl,
  web,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  passed,
  checks: k.checks,
})
console.log(`\n${passed ? 'passed' : 'FAILED'} — ${k.checks.length} checks, stored in ${file}`)
process.exit(passed ? 0 : 1)
