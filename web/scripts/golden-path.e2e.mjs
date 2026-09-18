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
  // A Brazilian browser with no stored choice must be answered in Portuguese (ADR 0044).
  const page = await browser.newPage({
    locale: 'pt-BR',
    viewport: { width: 1440, height: 900 },
  })
  page.setDefaultTimeout(60_000)
  const pageErrors = []
  const telemetryRequests = []
  let orderTraceId = ''
  let placedOrderId = ''
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
  page.on('response', async (response) => {
    const request = response.request()
    if (request.method() !== 'POST' || !response.url().endsWith('/api/horizon/sales/orders')) return
    if (response.ok()) placedOrderId = (await response.json().catch(() => ({}))).orderId ?? ''
  })

  await page.goto(`${appUrl}/login`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Entrar no Horizon' }).waitFor()
  await page.getByLabel('E-mail').fill('demo@horizon.local')
  await page.getByLabel('Senha').fill(password)
  const sessionResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url() === `${appUrl}/api/session`,
  )
  await page.getByRole('button', { name: 'Continuar' }).click()
  const sessionResponse = await sessionResponsePromise
  assert(
    sessionResponse.ok(),
    `login returned ${sessionResponse.status()}: ${await responseSummary(sessionResponse)}`,
  )
  await page.waitForURL(`${appUrl}/workspaces`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /Horizon Demo/ }).click()
  await page.waitForURL(`${appUrl}/app`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Boa tarde' }).waitFor()
  await page.getByRole('link', { name: 'Área de trabalho Horizon Demo' }).waitFor()

  // Switching language keeps the reader on the same resource and reaches the whole shell.
  await page.getByRole('combobox', { name: 'Idioma' }).click()
  await page.getByRole('option', { name: 'English' }).click()
  await page.getByRole('heading', { name: 'Good afternoon' }).waitFor()
  await page.getByRole('link', { name: 'Overview' }).waitFor()
  assert(
    (await page.locator('html').getAttribute('lang')) === 'en',
    'the document language did not follow the switcher',
  )

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

  // A customer is a party with the customer role (ADR 0040): the registry shows it with its roles.
  await page.getByRole('link', { name: 'Parties' }).click()
  await page.waitForURL(`${appUrl}/app/registrations/parties`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Parties', exact: true }).waitFor()
  await page
    .getByRole('row')
    .filter({ hasText: existingCustomer.email })
    .getByRole('button', { name: 'Roles' })
    .click()
  await page.getByRole('dialog', { name: /^Roles of / }).waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()

  await page.getByRole('link', { name: 'Quotes' }).click()
  await page.waitForURL(`${appUrl}/app/sales/quotes`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Quotes', exact: true }).waitFor()
  await page.getByRole('button', { name: 'New quote' }).click()
  await page.getByRole('dialog', { name: 'Create quote' }).waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()

  await page.getByRole('link', { name: 'Balances', exact: true }).click()
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

  // The confirmed order reaches Financial as a forecast, and invoicing turns that same
  // title into an effective receivable; a person then classifies it, posts it and records
  // the payment (ADR 0041, ADR 0042).
  assert(placedOrderId, 'the placed order id was not captured')
  const receivableNumber = `SO-${placedOrderId.slice(-8).toUpperCase()}`
  await page.getByRole('link', { name: 'Receivables' }).click()
  await page.waitForURL(`${appUrl}/app/finance/receivables`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Accounts receivable', exact: true }).waitFor()
  await waitUntil(
    () =>
      page.evaluate(async (orderId) => {
        const response = await fetch('/api/horizon/financial/receivables?view=draft&limit=100')
        if (!response.ok) return false
        const { data } = await response.json()
        return data.some((row) => row.origin.orderId === orderId)
      }, placedOrderId),
    'the forecast raised from the placed order, realised by invoicing',
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  // The forecast became the receivable rather than sitting beside it, so nothing is
  // expected any more and the same money is never counted twice.
  await page
    .getByRole('article')
    .filter({ hasText: 'Expected' })
    .getByText('—', { exact: true })
    .waitFor()
  assert(
    (await page.getByRole('tab', { name: /^Forecasts/ }).innerText()).includes('0'),
    'a forecast was left behind after invoicing',
  )
  await page.getByRole('button', { name: `Open receivable ${receivableNumber}` }).click()
  const receivableDialog = page.getByRole('dialog', { name: `Receivable ${receivableNumber}` })
  await receivableDialog.getByRole('button', { name: 'Save classification' }).click()
  await page.getByText('Classification saved.').waitFor()
  await receivableDialog.getByRole('button', { name: 'Post', exact: true }).click()
  await page.getByText('Receivable posted.').waitFor()
  await receivableDialog.getByRole('button', { name: 'Settle installment 1' }).click()
  await receivableDialog.getByRole('button', { name: 'Record settlement' }).click()
  await page.getByText('Settlement recorded.').waitFor()
  await receivableDialog.getByText('settled', { exact: true }).first().waitFor()
  await receivableDialog.getByRole('button', { name: 'Close dialog' }).click()

  // The books were written by the events those steps published, without anyone typing an
  // entry. The trial balance is the assertion: it balances, or the ledger is wrong.
  await page.getByRole('link', { name: 'The books' }).click()
  await page.waitForURL(`${appUrl}/app/finance/ledger`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'The books', exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Trial balance' }).click()
  await page.getByText('Debits equal credits').waitFor()

  // And a figure in a report leads back to the fact behind it, which is what makes the
  // books auditable rather than merely arithmetically consistent.
  await page.getByRole('button', { name: 'Open the lines of account 1.01' }).first().click()
  const ledgerDialog = page.getByRole('dialog')
  await ledgerDialog.getByText('Receivable', { exact: true }).first().waitFor()
  await ledgerDialog.getByText('Settlement', { exact: true }).first().waitFor()
  await ledgerDialog.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('link', { name: 'Receivables' }).click()
  await page.waitForURL(`${appUrl}/app/finance/receivables`, { waitUntil: 'domcontentloaded' })

  // A supplier invoice waits for a second person: whoever requests approval cannot give it.
  const supplierGrant = await page.evaluate(
    async (partyId) =>
      (
        await fetch(`/api/horizon/parties/parties/${partyId}/roles/supplier`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operation: 'grant' }),
        })
      ).status,
    existingCustomer.id,
  )
  // 409 on a rerun: the party already plays the role.
  assert([204, 409].includes(supplierGrant), `granting the supplier role returned ${supplierGrant}`)
  await page.getByRole('link', { name: 'Payables' }).click()
  await page.waitForURL(`${appUrl}/app/finance/payables`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Accounts payable', exact: true }).waitFor()
  await waitUntil(
    () =>
      page.evaluate(async (partyId) => {
        const response = await fetch('/api/horizon/financial/payables/counterparties')
        if (!response.ok) return false
        const { data } = await response.json()
        return data.some((row) => row.partyId === partyId)
      }, existingCustomer.id),
    'the supplier projection in Financial',
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Approval policy' }).click()
  await page.getByRole('dialog', { name: 'Approval policy' }).waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  const payableNumber = `NF-${randomUUID().slice(0, 8).toUpperCase()}`
  await page.getByRole('button', { name: 'New payable' }).click()
  const payableForm = page.getByRole('dialog', { name: 'New payable' })
  await payableForm.getByLabel('Document').fill(payableNumber)
  await payableForm.getByLabel('Amount').fill('123.45')
  await payableForm.getByRole('button', { name: 'Save draft' }).click()
  await page.getByText('Draft payable saved.').waitFor()
  await page.getByRole('button', { name: `Open payable ${payableNumber}` }).click()
  const payableDialog = page.getByRole('dialog', { name: `Payable ${payableNumber}` })
  await payableDialog.getByRole('button', { name: 'Request approval' }).click()
  await page.getByText('Approval requested.').waitFor()
  await payableDialog
    .getByText('You requested this approval, so another approver must decide it.')
    .waitFor()
  assert(
    (await payableDialog.getByRole('button', { name: 'Approve', exact: true }).count()) === 0,
    'the requester was offered their own approval',
  )
  await payableDialog.getByRole('button', { name: 'Close dialog' }).click()

  // Treasury: a transfer changes two book balances together and keeps their sum.
  const treasuryAccounts = await page.evaluate(async () => {
    const list = async () => (await (await fetch('/api/horizon/treasury/accounts')).json()).data
    for (const name of ['Golden checking', 'Golden savings']) {
      if ((await list()).some((account) => account.name === name)) continue
      const response = await fetch('/api/horizon/treasury/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          kind: 'cash',
          name,
          currency: 'BRL',
          openedOn: '2026-01-01',
          openingBalance: { amount: '100000', direction: 'inflow' },
        }),
      })
      if (!response.ok) return null
    }
    return (await list()).filter((account) => account.name.startsWith('Golden '))
  })
  assert(treasuryAccounts?.length === 2, 'the golden treasury accounts could not be opened')
  const totalBefore = treasuryAccounts.reduce((sum, account) => sum + BigInt(account.bookBalance), 0n)
  await page.getByRole('link', { name: 'Accounts and balances' }).click()
  await page.waitForURL(`${appUrl}/app/finance/treasury`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Accounts and balances', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Show the statement of Golden checking' }).click()
  await page.getByRole('heading', { name: 'Statement · Golden checking' }).waitFor()
  await page.getByRole('button', { name: 'New transfer' }).click()
  const transferForm = page.getByRole('dialog', { name: 'New transfer' })
  await chooseOption(page, transferForm.getByRole('combobox', { name: 'From' }), 'Golden checking')
  await chooseOption(page, transferForm.getByRole('combobox', { name: 'To' }), 'Golden savings')
  await transferForm.getByLabel('Amount').fill('12.34')
  await transferForm.getByLabel('Fee').fill('0.50')
  await transferForm.getByRole('button', { name: 'Transfer', exact: true }).click()
  await page.getByText('Transfer posted.').waitFor()
  const totalAfter = await page.evaluate(async () => {
    const { data } = await (await fetch('/api/horizon/treasury/accounts')).json()
    return data
      .filter((account) => account.name.startsWith('Golden '))
      .reduce((sum, account) => sum + BigInt(account.bookBalance), 0n)
      .toString()
  })
  assert(
    BigInt(totalAfter) === totalBefore - 50n,
    `the transfer changed the combined balance by more than its fee (${totalBefore} → ${totalAfter})`,
  )

  // Reconciliation: the bank's line for that transfer is imported once and matched by a person.
  const bankDescription = `TRANSFER GOLDEN ${randomUUID().slice(0, 8).toUpperCase()}`
  const now = new Date()
  const bankDate = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`
  const statementFile = {
    name: 'golden-statement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`Data;Histórico;Valor\n${bankDate};${bankDescription};-12,34\n`),
  }
  await page.getByRole('link', { name: 'Bank reconciliation' }).click()
  await page.waitForURL(`${appUrl}/app/finance/reconciliation`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Bank reconciliation', exact: true }).waitFor()
  await chooseOption(page, page.getByRole('combobox', { name: 'Account' }), 'Golden checking')
  for (const expected of ['1 new line imported, 0 already known.', '0 new lines imported, 1 already known.']) {
    await page.getByRole('button', { name: 'Import statement' }).click()
    const importForm = page.getByRole('dialog', { name: 'Import statement' })
    await importForm.getByLabel('Statement file').setInputFiles(statementFile)
    await importForm.getByRole('button', { name: 'Import', exact: true }).click()
    await page.getByText(expected).waitFor()
  }
  await page.getByRole('button', { name: `Accept the suggestion for ${bankDescription}` }).click()
  await page.getByText('Reconciliation confirmed.').waitFor()
  const reconciledLine = await page.evaluate(async (description) => {
    const accounts = (await (await fetch('/api/horizon/treasury/accounts')).json()).data
    const checking = accounts.find((account) => account.name === 'Golden checking')
    const workspace = await (
      await fetch(`/api/horizon/treasury/accounts/${checking.id}/reconciliation`)
    ).json()
    return workspace.lines.find((line) => line.description === description)?.status ?? null
  }, bankDescription)
  assert(reconciledLine === 'matched', `the imported bank line is ${reconciledLine}, not matched`)

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

  await page.getByRole('link', { name: 'Classifications' }).click()
  await page.waitForURL(`${appUrl}/app/administration/classifications`, {
    waitUntil: 'domcontentloaded',
  })
  await page.getByRole('heading', { name: 'Classifications', exact: true }).waitFor()
  await page.getByRole('tab', { name: /Payment terms/ }).click()
  await page.getByRole('button', { name: 'New payment term' }).click()
  const termDialog = page.getByRole('dialog', { name: 'New payment term' })
  await termDialog.getByLabel('Percentage').fill('99')
  await termDialog.getByText('Total: 99%').waitFor()
  await termDialog.getByRole('button', { name: 'Close dialog' }).click()

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
    ['Parties', 'Parties'],
    ['Quotes', 'Quotes'],
    ['Balances', 'Inventory'],
    ['Orders', 'Orders'],
    ['Webhooks', 'Webhooks'],
    ['Delivery logs', 'Delivery logs'],
    ['People and access', 'People & access'],
    ['API keys', 'API keys'],
    ['Classifications', 'Classifications'],
    ['Receivables', 'Accounts receivable'],
    ['Payables', 'Accounts payable'],
    ['Accounts and balances', 'Accounts and balances'],
    ['Bank reconciliation', 'Bank reconciliation'],
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

/**
 * Picks an option of a Base UI select by typing its label, as a keyboard user would. Inside a
 * dialog the open list overlaps its trigger, so pointer clicks on options are unreliable.
 */
async function chooseOption(page, combobox, label) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await combobox.textContent())?.includes(label)) return
    await combobox.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.type(label)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
  }
  assert((await combobox.textContent())?.includes(label), `could not choose ${label}`)
}

async function waitUntil(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
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
