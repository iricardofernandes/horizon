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
  await page.waitForURL(`${appUrl}/workspaces`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /Horizon Demo/ }).click()
  await page.waitForURL(`${appUrl}/app`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Good afternoon' }).waitFor()
  await page.getByRole('link', { name: 'Horizon Demo workspace' }).waitFor()
  await page.getByRole('link', { name: 'Horizon Demo workspace' }).click()
  await page.waitForURL(`${appUrl}/workspaces`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /Horizon Demo/ }).click()
  await page.waitForURL(`${appUrl}/app`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Good afternoon' }).waitFor()
  await page.getByRole('link', { name: 'Horizon Demo workspace' }).waitFor()
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  assert(
    await page.locator('.workspace-shell').evaluate((element) =>
      element.classList.contains('sidebar-collapsed'),
    ),
    'the desktop sidebar did not collapse',
  )
  await page.getByRole('button', { name: 'Expand sidebar' }).click()

  await page.getByRole('link', { name: 'Items' }).click()
  await page.waitForURL(`${appUrl}/app/catalog/items`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Catalog', exact: true }).waitFor()
  await page.getByRole('button', { name: 'New item' }).click()
  await page.getByRole('dialog', { name: 'Create item' }).waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('tab', { name: /Units/ }).click()
  await page.getByRole('button', { name: 'New unit' }).click()
  await page.getByRole('dialog', { name: 'Create unit' }).waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('tab', { name: /Price lists/ }).click()
  await page.getByRole('button', { name: 'New price list' }).click()
  await page.getByRole('dialog', { name: 'Create price list' }).waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()

  await page.getByRole('link', { name: 'Customers' }).click()
  await page.waitForURL(`${appUrl}/app/sales/customers`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Customers', exact: true }).waitFor()
  const existingCustomer = await page.evaluate(async () => {
    const response = await fetch('/api/horizon/sales/customers')
    if (!response.ok) return null
    const rows = await response.json()
    return rows.find((row) => row.status === 'active') ?? null
  })
  assert(existingCustomer, 'the customer fixture is missing')
  await page.getByRole('button', { name: 'New customer' }).click()
  const customerDialog = page.getByRole('dialog', { name: 'Create customer' })
  await customerDialog.getByLabel('Name').fill(existingCustomer.name)
  await customerDialog.getByLabel('Tax ID').fill('123456789012')
  await customerDialog.getByLabel('Email').fill(existingCustomer.email)
  await customerDialog.getByLabel('Phone').fill(existingCustomer.phone)
  await customerDialog.getByLabel('Address').fill(existingCustomer.address)
  await customerDialog.getByRole('button', { name: 'Create customer' }).click()
  await customerDialog.getByText('must be a CPF or CNPJ with 11 or 14 digits').waitFor()
  await customerDialog.getByRole('button', { name: 'Close dialog' }).click()
  const customerRow = page.getByRole('row').filter({ hasText: existingCustomer.email })
  await customerRow.getByRole('button', { name: 'Erase data' }).click()
  await page.getByRole('alertdialog').waitFor()
  await page.getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('link', { name: 'Quotes' }).click()
  await page.waitForURL(`${appUrl}/app/sales/quotes`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Quotes', exact: true }).waitFor()
  await page.getByRole('button', { name: 'New quote' }).click()
  await page.getByRole('dialog', { name: 'Create quote' }).waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()

  await page.getByRole('link', { name: 'Balances' }).click()
  await page.waitForURL(`${appUrl}/app/inventory/balances`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Inventory', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Receive stock' }).click()
  await page.getByRole('dialog', { name: 'Receive stock' }).waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('button', { name: 'New warehouse' }).click()
  await page.getByRole('dialog', { name: 'Create warehouse' }).waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()

  await page.getByRole('link', { name: 'Orders' }).click()
  await page.waitForURL(`${appUrl}/app/sales/orders`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Orders', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Add line' }).click()
  await page.getByRole('button', { name: 'Remove item 2' }).click()
  await page.getByLabel('Quantity').fill('1')
  await page.getByRole('button', { name: 'Place order' }).click()
  await page.getByText('Order confirmed and stock committed.').waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Details' }).first().click()
  await page.getByRole('dialog', { name: /^Order / }).waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  assert(orderTraceId, 'the order request did not carry traceparent')

  await page.getByRole('link', { name: 'Webhooks' }).click()
  await page.waitForURL(`${appUrl}/app/developers/webhooks`, { waitUntil: 'domcontentloaded' })
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

  await page.getByRole('link', { name: 'Delivery logs' }).click()
  await page.waitForURL(`${appUrl}/app/developers/deliveries`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Delivery logs', exact: true }).waitFor()

  await page.getByRole('link', { name: 'People and access' }).click()
  await page.waitForURL(`${appUrl}/app/administration/people`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'People & access', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Add member' }).click()
  await page.getByRole('dialog', { name: 'Add workspace member' }).waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('button', { name: 'Roles' }).first().click()
  await page.getByRole('dialog', { name: /^Roles for / }).waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()

  await page.getByRole('link', { name: 'API keys' }).click()
  await page.waitForURL(`${appUrl}/app/developers/api-keys`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'API keys', exact: true }).waitFor()
  await page.getByRole('button', { name: 'New API key' }).click()
  await page.getByRole('dialog', { name: 'Create API key' }).waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()

  await page.getByRole('link', { name: 'Workspace', exact: true }).click()
  await page.waitForURL(`${appUrl}/app/administration/workspace`, {
    waitUntil: 'domcontentloaded',
  })
  await page.getByRole('heading', { name: 'Workspace', exact: true }).waitFor()

  // A screen is reachable by URL, and the server still decides what it may show.
  await page.goto(`${appUrl}/app/sales/orders`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Orders', exact: true }).waitFor()

  await page.setViewportSize({ width: 390, height: 844 })
  for (const screen of [
    ['Items', 'Catalog'],
    ['Customers', 'Customers'],
    ['Quotes', 'Quotes'],
    ['Balances', 'Inventory'],
    ['Orders', 'Orders'],
    ['Webhooks', 'Webhooks'],
    ['Delivery logs', 'Delivery logs'],
    ['People and access', 'People & access'],
    ['API keys', 'API keys'],
  ]) {
    await page.getByRole('link', { name: screen[0], exact: true }).click()
    await page.getByRole('heading', { name: screen[1], exact: true }).waitFor()
    const documentOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    assert(!documentOverflows, `${screen[0]} overflows the 390px document viewport`)
  }
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
