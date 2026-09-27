/**
 * Phase 53 browser workflow for the service screens, against the local stack.
 *
 * It prepares a priced Catalog service with its fiscal profile and a customer with a
 * national fiscal profile through the API, turns the establishment's NFS-e policy to
 * `automatic`, and then works only through the screens, in pt-BR:
 *   - a service order is opened, started, delivered and accepted; its delivery shows a draft
 *     receivable and an authorized NFS-e, and the NFS-e link opens the Fiscal document;
 *   - a monthly contract from last month is drafted and activated, billed from the billing
 *     screen after a preview, and its billed period shows its NFS-e; a credit from the
 *     screen marks it credited and cancels the NFS-e;
 *   - the customer's services list both documents.
 * Then it reads the three screens and a contract's tabs in English, and restores the policy.
 *
 *   node scripts/services-workflow.e2e.mjs
 *     [HORIZON_WEB_URL, HORIZON_FISCAL_OPERATOR_EMAIL, HORIZON_FISCAL_WORKSPACE,
 *      HORIZON_FISCAL_TENANT, HORIZON_DEMO_PASSWORD, CHROMIUM_PATH]
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const appUrl = process.env.HORIZON_WEB_URL ?? 'http://localhost:3000'
const apiUrl = process.env.HORIZON_API_URL ?? 'http://localhost:8000'
const email = process.env.HORIZON_FISCAL_OPERATOR_EMAIL ?? 'fiscal.operator@horizon.local'
const workspace = process.env.HORIZON_FISCAL_WORKSPACE ?? 'Phase 39 validation'
const tenantId = process.env.HORIZON_FISCAL_TENANT ?? '01a0c5f8-798b-721e-912e-9b505406e614'
const password = process.env.HORIZON_DEMO_PASSWORD ?? 'Horizon-demo-2026!'
const executablePath = await firstExisting([
  process.env.CHROMIUM_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  chromium.executablePath(),
])
if (!executablePath) throw new Error('No Chromium executable found; set CHROMIUM_PATH')

const api = apiClient()
const fixture = await prepare()
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const evidence = { checkedAt: new Date().toISOString(), workspace, fixture, steps: [] }
try {
  const context = await browser.newContext({ locale: 'pt-BR', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`${appUrl}/login`, { waitUntil: 'domcontentloaded' })
  await page.getByLabel('E-mail').fill(email)
  await page.getByLabel('Senha').fill(password)
  await page.getByRole('button', { name: 'Continuar' }).click()
  await page.waitForURL(`${appUrl}/workspaces`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: new RegExp(workspace) }).click()
  await page.waitForURL(`${appUrl}/app`, { waitUntil: 'domcontentloaded' })
  await setLanguage(page, 'Português (Brasil)')

  // --- a service order, from opening to acceptance -------------------------------------------
  await page.getByRole('link', { name: 'Ordens de serviço' }).click()
  await page.getByRole('heading', { name: 'Ordens de serviço', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Nova ordem de serviço' }).click()
  const newOrder = page.getByRole('dialog', { name: 'Nova ordem de serviço' })
  await chooseOption(page, newOrder.getByRole('combobox', { name: 'Cliente' }), fixture.customerName)
  await chooseOption(page, newOrder.getByRole('combobox', { name: 'Serviço 1' }), fixture.serviceName)
  await newOrder.getByLabel('Quantidade').fill('2')
  const opened = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/horizon/sales/service-orders'),
  )
  await newOrder.getByRole('button', { name: 'Abrir ordem de serviço' }).click()
  const { serviceOrderId } = await (await opened).json()
  const orderRef = `OS-${serviceOrderId.slice(-8).toUpperCase()}`
  await page.getByText('Ordem de serviço aberta.').waitFor()
  await page.getByRole('button', { name: `Abrir ordem de serviço ${orderRef}` }).click()
  const order = page.getByRole('dialog', { name: `Ordem de serviço ${orderRef}` })
  await order.getByRole('button', { name: 'Iniciar execução' }).click()
  await order.getByText('em execução').first().waitFor()
  await order.getByLabel(new RegExp(`^Quantidade de ${fixture.serviceName}`)).fill('1')
  await order.getByRole('button', { name: 'Registrar entrega' }).click()
  await order.locator('tbody tr', { hasText: /^SV-/ }).first().waitFor()
  await order.getByLabel(new RegExp(`^Quantidade de ${fixture.serviceName}`)).fill('1')
  await order.getByRole('button', { name: 'Registrar entrega' }).click()
  await order.getByRole('button', { name: 'Registrar aceite' }).click()
  await order.getByText('aceito').first().waitFor()
  const deliveries = order.locator('tbody tr', { has: page.locator('code', { hasText: /^SV-/ }) })
  assert((await deliveries.count()) === 2, 'two deliveries were recorded')
  // Fiscal issues at once under `automatic`; Sales learns it from the outcome event.
  await eventually(page, async () => {
    await order.getByRole('button', { name: 'Fechar janela' }).click()
    await page.getByRole('button', { name: `Abrir ordem de serviço ${orderRef}` }).click()
    await order.getByText('Entregas', { exact: true }).waitFor()
    return (await order.getByText('autorizado').count()) === 2
  })
  await order.getByText('rascunho').first().waitFor()
  evidence.steps.push({ step: 'service-order', serviceOrderId, deliveries: 2, nfse: 'autorizado' })

  // The NFS-e link opens the document in the Fiscal screen.
  await order.getByRole('link', { name: 'Ver documento' }).first().click()
  await page.waitForURL(/\/app\/fiscal\/documents\?open=/)
  const nfse = page.getByRole('dialog', { name: /^NFS-e/ })
  await nfse.waitFor()
  await nfse.getByText('Simulação — sem valor fiscal').waitFor()
  await nfse.getByRole('button', { name: 'Fechar janela' }).click()
  evidence.steps.push({ step: 'nfse-link', opened: true })

  // --- a contract, billed from the billing screen and credited ---------------------------------
  await page.getByRole('link', { name: 'Contratos', exact: true }).click()
  await page.getByRole('heading', { name: 'Contratos', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Novo contrato' }).click()
  const newContract = page.getByRole('dialog', { name: 'Novo contrato' })
  await chooseOption(page, newContract.getByRole('combobox', { name: 'Cliente' }), fixture.customerName)
  await chooseOption(page, newContract.getByRole('combobox', { name: 'Serviço 1' }), fixture.serviceName)
  await newContract.getByLabel('Preço negociado').fill('450.00')
  await newContract.getByLabel('Início (mês)').fill(lastMonth())
  await newContract.getByLabel('Dia de cobrança').fill('1')
  const created = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/horizon/sales/contracts'),
  )
  await newContract.getByRole('button', { name: 'Criar rascunho' }).click()
  const { contractId } = await (await created).json()
  const contractRef = `CTR-${contractId.slice(-8).toUpperCase()}`
  await page.getByText('Contrato criado como rascunho.').waitFor()
  await page.getByRole('button', { name: `Abrir contrato ${contractRef}` }).click()
  const contract = page.getByRole('dialog', { name: `Contrato ${contractRef}` })
  await contract.getByRole('button', { name: 'Ativar contrato' }).click()
  await contract.getByText('ativo').first().waitFor()
  await contract.getByRole('tab', { name: 'Cronograma' }).click()
  await contract.getByText('a faturar').first().waitFor()
  await contract.getByRole('button', { name: 'Fechar janela' }).click()

  await page.getByRole('link', { name: 'Faturamento de contratos' }).click()
  await page.getByRole('heading', { name: 'Faturamento de contratos', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Ver prévia' }).click()
  const previewRow = page.locator('tr', { hasText: contractRef })
  await previewRow.getByText('faturado').waitFor()
  await page.getByRole('button', { name: 'Faturar mês' }).click()
  await page.getByText(/^Faturamento de \d{4}-\d{2} concluído\.$/).waitFor()
  await page.locator('.billing-run tr', { hasText: contractRef }).getByText('faturado').waitFor()
  evidence.steps.push({ step: 'billing-run', contractId })

  await page.getByRole('link', { name: 'Contratos', exact: true }).click()
  await page.getByRole('button', { name: `Abrir contrato ${contractRef}` }).click()
  await eventually(page, async () => {
    await contract.getByRole('button', { name: 'Fechar janela' }).click()
    await page.getByRole('button', { name: `Abrir contrato ${contractRef}` }).click()
    await contract.getByRole('tab', { name: 'Faturados' }).click()
    await contract.locator('.contract-tab tbody tr').first().waitFor()
    return (await contract.getByText('autorizado').count()) >= 1
  })
  await contract.getByRole('button', { name: 'Creditar período' }).first().click()
  await chooseOption(page, contract.getByRole('combobox', { name: 'Tipo de crédito' }), 'Faturado errado')
  await contract.getByRole('textbox', { name: 'Motivo' }).last().fill('Faturado com o posto errado')
  await contract.getByRole('button', { name: 'Confirmar' }).click()
  await contract.getByText(/^Faturado errado · Faturado com o posto errado$/).waitFor()
  await eventually(page, async () => {
    await contract.getByRole('button', { name: 'Fechar janela' }).click()
    await page.getByRole('button', { name: `Abrir contrato ${contractRef}` }).click()
    await contract.getByRole('tab', { name: 'Faturados' }).click()
    await contract.locator('.contract-tab tbody tr').first().waitFor()
    return (await contract.getByText('cancelado').count()) >= 1
  })
  // Financial withdrew the draft the period raised; the screen says so.
  await contract.getByText('retirado').first().waitFor()
  await contract.getByRole('tab', { name: 'Cronograma' }).click()
  await contract.getByText('creditado').first().waitFor()
  evidence.steps.push({ step: 'credit', contractId, nfse: 'cancelado' })
  await contract.getByRole('button', { name: 'Fechar janela' }).click()

  // --- the customer's services -------------------------------------------------------------------
  await page.getByRole('link', { name: 'Clientes' }).click()
  await page.getByRole('button', { name: `Serviços e contratos de ${fixture.customerName}` }).click()
  const services = page.getByRole('dialog', { name: `Serviços de ${fixture.customerName}` })
  await services.getByText(orderRef).waitFor()
  await services.getByText(contractRef).waitFor()
  evidence.steps.push({ step: 'customer-services', orders: 1, contracts: 1 })
  await services.getByRole('button', { name: 'Fechar janela' }).click()

  // --- the same screens in English -----------------------------------------------------------
  await setLanguage(page, 'English')
  await page.getByRole('link', { name: 'Service orders' }).click()
  await page.getByRole('heading', { name: 'Service orders', exact: true }).waitFor()
  await page.getByRole('region', { name: 'Accepted' }).waitFor()
  await page.getByRole('link', { name: 'Contracts', exact: true }).click()
  await page.getByRole('heading', { name: 'Contracts', exact: true }).waitFor()
  await page.getByRole('button', { name: `Open contract ${contractRef}` }).click()
  const english = page.getByRole('dialog', { name: `Contract ${contractRef}` })
  await english.getByRole('tab', { name: 'Billed' }).click()
  await english.getByText(/^Billed in error · /).waitFor()
  await english.getByRole('tab', { name: 'Schedule' }).click()
  await english.getByText('credited').first().waitFor()
  await english.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('link', { name: 'Contract billing' }).click()
  await page.getByRole('heading', { name: 'Contract billing', exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Recent runs' }).waitFor()
  evidence.steps.push({ step: 'english', screens: ['Service orders', 'Contracts', 'Contract billing'] })
  await setLanguage(page, 'Português (Brasil)')

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  const shot = join(process.env.HORIZON_SCREENSHOT_DIR ?? '/tmp', 'services-workflow-failure.png')
  await browser
    .contexts()[0]
    ?.pages()[0]
    ?.screenshot({ path: shot, fullPage: true })
    .catch(() => undefined)
  console.error(`screenshot: ${shot}`)
  throw error
} finally {
  await browser.close()
  await api('PUT', `/fiscal/service-issuance-policies/${tenantId}`, {
    mode: 'review',
    series: 1,
    reason: 'Revisão por pessoa restaurada após o teste de navegador',
  }).catch(() => undefined)
}

/** A priced service with its fiscal profile and a customer the NFS-e can be issued to. */
async function prepare() {
  const stamp = Date.now().toString(36).toUpperCase()
  const serviceName = `Suporte recorrente ${stamp}`
  const customerName = `Cliente Serviços ${stamp} LTDA`
  const [unit] = (await api('GET', '/catalog/units')).data
  const item = await api('POST', '/catalog/items', {
    kind: 'service',
    sku: `WEB53-${stamp}`,
    name: serviceName,
    unitId: unit.id,
  })
  const itemId = item.id ?? item.itemId
  const lists = await api('GET', '/catalog/price-lists')
  const priceList = (lists.data ?? lists).find((row) => row.currency === 'BRL')
  await api('PUT', `/catalog/price-lists/${priceList.id}/prices/${itemId}`, {
    amount: '50000',
    currency: 'BRL',
  })
  await until('the service fiscal profile', () =>
    api('POST', '/fiscal/service-profiles', {
      itemId,
      nationalTaxCode: '010101',
      nbsCode: '115022000',
      issTaxation: '1',
      description: serviceName,
      effectiveFrom: '2026-01-01',
      reason: 'Classificação revisada no teste de navegador da fase 53',
    }),
  )
  const party = await api('POST', '/parties/parties', {
    kind: 'organization',
    taxId: cnpj(),
    roles: ['customer'],
    legalName: customerName,
    email: `servicos53-${stamp.toLowerCase()}@example.com`,
    phone: '11999990000',
    address: 'Avenida Paulista, 1000, São Paulo',
  })
  const customerId = party.id ?? party.partyId
  await api('PUT', `/parties/parties/${customerId}/fiscal-profile`, {
    effectiveFrom: '2026-01-01',
    stateRegistration: null,
    municipalRegistration: null,
    taxpayerIndicator: 'non-contributor',
    finalConsumer: false,
    address: {
      street: 'Avenida Paulista',
      number: '1000',
      complement: 'Conjunto 101',
      district: 'Bela Vista',
      city: 'São Paulo',
      municipalityCode: '3550308',
      state: 'SP',
      postalCode: '01310100',
      country: 'BR',
    },
  })
  await until('Sales to know the customer and the priced service', async () => {
    const customers = await api('GET', '/sales/customers')
    return customers.some((row) => (row.id ?? row.partyId) === customerId)
  })
  await api('PUT', `/fiscal/service-issuance-policies/${tenantId}`, {
    mode: 'automatic',
    series: 53,
    reason: 'Emissão automática para o teste de navegador da fase 53',
  })
  return { serviceName, customerName, itemId, customerId }
}

function apiClient() {
  const token = execFileSync(
    process.execPath,
    [
      join(root, 'infra/scripts/mint-dev-token.mjs'),
      '--tenant',
      tenantId,
      '--sub',
      randomUUID(),
      ...['parties:admin', 'sales:admin', 'catalog:admin', 'fiscal:admin'].flatMap((role) => [
        '--role',
        role,
      ]),
    ],
    { encoding: 'utf8' },
  ).trim()
  return async (method, path, body) => {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
}

/** Retries a check that depends on the broker and the Fiscal worker, reopening the screen. */
async function eventually(page, probe, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return
    await page.waitForTimeout(2_000)
  }
  throw new Error('Timed out waiting for the screen to show the downstream effect')
}

async function until(label, probe, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      if (await probe()) return
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`)
}

/** `YYYY-MM` of last month, as the month input takes it. */
function lastMonth() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
}

function cnpj() {
  const digits = [...Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)), 0, 0, 0, 1]
  for (const weights of [
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  ]) {
    const rest = digits.reduce((sum, value, index) => sum + value * weights[index], 0) % 11
    digits.push(rest < 2 ? 0 : 11 - rest)
  }
  return digits.join('')
}

async function setLanguage(page, label) {
  const switcher = page.getByRole('combobox', { name: /^(Idioma|Language)$/ })
  if ((await switcher.textContent())?.includes(label)) return
  await switcher.click()
  await page.getByRole('option', { name: label }).click()
  await page.waitForTimeout(500)
}

async function chooseOption(page, combobox, label) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await combobox.textContent())?.includes(label)) return
    await combobox.click()
    const option = page.getByRole('option', { name: label, exact: false }).first()
    // A long list can sit under the dialog's fields; the keyboard reaches any option.
    await option.click({ timeout: 3_000 }).catch(async () => {
      await option.focus()
      await page.keyboard.press('Enter')
    })
    await page.waitForTimeout(300)
  }
  assert((await combobox.textContent())?.includes(label), `could not choose ${label}`)
}

async function firstExisting(paths) {
  for (const path of paths.filter(Boolean)) {
    try {
      await access(path)
      return path
    } catch {}
  }
  return null
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
