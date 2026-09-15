import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const appUrl = process.env.HORIZON_WEB_URL ?? 'http://localhost:3000'
const jaegerUrl = process.env.HORIZON_JAEGER_URL ?? 'http://localhost:16686'
const password = process.env.HORIZON_DEMO_PASSWORD ?? 'Horizon-demo-2026!'
const chromiumCandidates = [
  process.env.CHROMIUM_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  chromium.executablePath(),
].filter(Boolean)

const executablePath = await firstExisting(chromiumCandidates)
if (!executablePath) throw new Error('No Chromium executable found; set CHROMIUM_PATH')

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(60_000)
  const pageErrors = []
  const telemetryRequests = []
  let orderTraceId = ''
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('response', (response) => {
    if (response.url().includes('/v1/traces'))
      telemetryRequests.push(`${response.status()} ${response.url()}`)
  })
  page.on('requestfailed', (request) => {
    if (request.url().includes('/v1/traces'))
      telemetryRequests.push(`failed ${request.failure()?.errorText ?? request.url()}`)
  })
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().includes('/api/horizon/sales/orders')) return
    const traceparent = request.headers().traceparent
    orderTraceId = traceparent?.split('-')[1] ?? ''
  })

  await page.goto(`${appUrl}/login`, { waitUntil: 'domcontentloaded' })
  await page.getByLabel('Workspace').fill('horizon-demo')
  await page.getByLabel('Email').fill('demo@horizon.local')
  await page.getByLabel('Password').fill(password)
  const sessionResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url() === `${appUrl}/api/session`,
  )
  await page.getByRole('button', { name: 'Continue' }).click()
  const sessionResponse = await sessionResponsePromise
  assert(
    sessionResponse.ok(),
    `login returned ${sessionResponse.status()}: ${await responseSummary(sessionResponse)}`,
  )
  await page.waitForURL(`${appUrl}/app`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Good afternoon' }).waitFor()

  await page.getByRole('button', { name: 'Orders' }).click()
  await page.getByRole('heading', { name: 'Orders', exact: true }).waitFor()
  await page.getByLabel('Quantity').fill('1')
  await page.getByRole('button', { name: 'Place order' }).click()
  await page.getByText('Order confirmed and stock committed.').waitFor({ timeout: 20_000 })
  assert(orderTraceId, 'the order request did not carry traceparent')

  await page.getByRole('button', { name: 'Webhooks' }).click()
  await page.getByRole('heading', { name: 'Webhooks', exact: true }).waitFor()
  const endpoint = `https://example.com/horizon-phase10/${randomUUID()}`
  await page.getByLabel('Endpoint URL').fill(endpoint)
  await page.getByRole('button', { name: 'Create subscription' }).click()
  await page.getByText('Signing secret · shown once').waitFor()

  const removed = await page.evaluate(async (createdEndpoint) => {
    const list = await fetch('/api/horizon/webhooks/webhook-subscriptions')
    if (!list.ok) return false
    const rows = await list.json()
    const subscription = rows.find((row) => row.endpointUrl === createdEndpoint)
    if (!subscription) return false
    return (await fetch(`/api/horizon/webhooks/webhook-subscriptions/${subscription.id}`, {
      method: 'DELETE',
    })).ok
  }, endpoint)
  assert(removed, 'the temporary webhook subscription could not be cleaned up')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Catalog' }).click()
  const documentOverflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  assert(!documentOverflows, 'the 390px layout overflows the document viewport')
  assert(pageErrors.length === 0, `browser errors: ${pageErrors.join('; ')}`)

  const services = await waitForTrace(orderTraceId)
  assert(
    services.includes('web'),
    `the browser span was not exported to Jaeger (${telemetryRequests.join(', ') || 'no OTLP request'})`,
  )
  assert(services.includes('sales'), 'the Sales span did not join the browser trace')

  process.stdout.write(
    `${JSON.stringify({ status: 'ok', traceId: orderTraceId, services, responsiveWidth: 390 })}\n`,
  )
} finally {
  await browser.close()
}

async function waitForTrace(traceId) {
  const deadline = Date.now() + 20_000
  do {
    const response = await fetch(`${jaegerUrl}/api/traces/${traceId}`).catch(() => null)
    if (response?.ok) {
      const payload = await response.json()
      const services = [
        ...new Set(
          (payload.data ?? []).flatMap((trace) =>
            Object.values(trace.processes ?? {}).map((process) => process.serviceName),
          ),
        ),
      ].sort()
      if (services.includes('web') && services.includes('sales')) return services
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  } while (Date.now() < deadline)
  return []
}

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path)
      return path
    } catch {}
  }
  return null
}

async function responseSummary(response) {
  const contentType = response.headers()['content-type'] ?? ''
  if (!contentType.includes('application/json') && !contentType.startsWith('text/'))
    return contentType || 'non-text response'
  return (await response.text().catch(() => 'unreadable response')).slice(0, 500)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
