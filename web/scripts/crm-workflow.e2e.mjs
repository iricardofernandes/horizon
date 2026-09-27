/**
 * Phase 60 browser workflow for the CRM screens, against the local stack.
 *
 * It grants the fiscal operator `crm:admin` through Identity, then works only through the
 * screens, in pt-BR:
 *   - settings: a pipeline with two stages, a source and a loss reason;
 *   - accounts: a prospect without a document registered from the CRM, a contact added,
 *     a call recorded with that contact;
 *   - pipeline: an opportunity opened, moved by dragging and with the arrow keys; a task
 *     with a reminder and a note written from its dialog; the task on my agenda;
 *   - conversion: the prospect made a customer, the quote written for the opportunity,
 *     sent and accepted in Sales, and the opportunity shown as won by that quote;
 *   - forecast and metrics read at the current cutoff.
 * Then it reads every CRM screen and the opportunity dialog in English.
 *
 *   node scripts/crm-workflow.e2e.mjs
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
const stamp = Date.now().toString(36).toUpperCase()
const names = {
  pipeline: `Funil web ${stamp}`,
  source: `Feira ${stamp}`,
  reason: `Preço ${stamp}`,
  prospect: `Prospect Web ${stamp} Ltda`,
  contact: `Contato ${stamp}`,
  opportunity: `Oportunidade web ${stamp}`,
}
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const evidence = { checkedAt: new Date().toISOString(), workspace, names, steps: [] }
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

  // --- settings: a pipeline, its stages, a source and a loss reason ----------------------------
  await page.getByRole('link', { name: 'Configurações do CRM' }).click()
  await page.getByRole('heading', { name: 'Configurações do CRM', exact: true }).waitFor()
  await page.getByLabel('Nome do funil').fill(names.pipeline)
  await page.getByLabel('Primeira etapa').fill('Qualificação')
  await page.getByRole('button', { name: 'Criar funil' }).click()
  const card = page.getByRole('article', { name: names.pipeline })
  await card.waitFor()
  await card.getByLabel('Etapa').last().fill('Proposta')
  await card.getByLabel('Probabilidade de ganho (%)').last().fill('60')
  await card.getByRole('button', { name: 'Adicionar etapa' }).click()
  await card.getByRole('button', { name: 'Descer Proposta' }).waitFor()
  await addEntry(page, 'Origens', names.source)
  await addEntry(page, 'Motivos de perda', names.reason)
  evidence.steps.push({ step: 'settings', pipeline: names.pipeline })

  // --- accounts: a prospect without a document, a contact, a call -----------------------------
  await page.getByRole('link', { name: 'Contas', exact: true }).click()
  await page.getByRole('heading', { name: 'Contas', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Novo prospect' }).click()
  const register = page.getByRole('dialog', { name: 'Novo prospect' })
  await register.getByLabel('Nome', { exact: true }).fill(names.prospect)
  await chooseOption(page, register.getByRole('combobox', { name: 'Documento' }), 'Sem documento')
  await register.getByLabel('E-mail').fill(`prospect-${stamp.toLowerCase()}@example.com`)
  await register.getByLabel('Telefone').fill(`119${String(Date.now()).slice(-8)}`)
  await register.getByLabel('Endereço').fill('Rua das Flores, 100, São Paulo')
  await register.getByRole('button', { name: 'Registrar prospect' }).click()
  // A lookalike in the registry must be confirmed, not ignored (Phase 54).
  const anyway = register.getByRole('button', { name: 'Cadastrar mesmo assim' })
  if (await anyway.isVisible({ timeout: 3_000 }).catch(() => false)) await anyway.click()
  await page.getByText('Prospect registrado.').waitFor()
  await eventually(page, async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Contas', exact: true }).waitFor()
    return (await page.getByRole('button', { name: `Abrir conta ${names.prospect}` }).count()) === 1
  })
  await page.getByRole('button', { name: `Abrir conta ${names.prospect}` }).click()
  const account = page.getByRole('dialog', { name: names.prospect })
  await account.getByRole('textbox', { name: 'Nome' }).fill(names.contact)
  await account.getByRole('textbox', { name: 'Cargo' }).fill('Compras')
  await account.getByRole('button', { name: 'Adicionar contato' }).click()
  await account.getByText(names.contact).first().waitFor()
  await account.getByLabel('Título').first().fill('Primeira ligação')
  await account.getByRole('checkbox', { name: names.contact }).check()
  await account.getByRole('button', { name: 'Registrar atividade' }).click()
  await account.locator('.crm-timeline').getByText('Ligação · Primeira ligação').waitFor()
  await account.getByRole('button', { name: 'Fechar janela' }).click()
  evidence.steps.push({ step: 'account', prospect: names.prospect, contact: names.contact })

  // --- pipeline: an opportunity, dragged and moved with the keyboard --------------------------
  await page.getByRole('link', { name: 'Funil de vendas' }).click()
  await page.getByRole('heading', { name: 'Funil de vendas', exact: true }).waitFor()
  await chooseOption(page, page.getByRole('combobox', { name: 'Funil', exact: true }), names.pipeline)
  await page.getByRole('button', { name: 'Nova oportunidade' }).click()
  const create = page.getByRole('dialog', { name: 'Nova oportunidade' })
  await chooseOption(page, create.getByRole('combobox', { name: 'Conta' }), names.prospect)
  await create.getByLabel('Título').fill(names.opportunity)
  await create.getByLabel('Valor esperado').fill('4500.00')
  await create.getByLabel('Fechamento previsto').fill(nextMonthDay())
  await chooseOption(page, create.getByRole('combobox', { name: 'Origem' }), names.source)
  const opened = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/horizon/crm/opportunities'),
  )
  await create.getByRole('button', { name: 'Abrir oportunidade' }).click()
  const { opportunityId } = await (await opened).json()
  await page.getByText('Oportunidade aberta.').waitFor()
  const qualify = page.getByRole('region', { name: 'Qualificação' })
  const propose = page.getByRole('region', { name: 'Proposta' })
  const oppCard = () => page.getByRole('button', { name: `Abrir oportunidade ${names.opportunity}` })
  await qualify.getByRole('button', { name: `Abrir oportunidade ${names.opportunity}` }).waitFor()
  await oppCard().dragTo(propose)
  await propose.getByRole('button', { name: `Abrir oportunidade ${names.opportunity}` }).waitFor()
  await oppCard().focus()
  await page.keyboard.press('ArrowLeft')
  await page.getByText(`${names.opportunity} movida para Qualificação.`).waitFor()
  await qualify.getByRole('button', { name: `Abrir oportunidade ${names.opportunity}` }).waitFor()
  await oppCard().focus()
  await page.keyboard.press('ArrowRight')
  await propose.getByRole('button', { name: `Abrir oportunidade ${names.opportunity}` }).waitFor()
  evidence.steps.push({ step: 'board', opportunityId, moves: ['drag', 'ArrowLeft', 'ArrowRight'] })

  // --- the opportunity: a task with a reminder, a note -----------------------------------------
  await oppCard().click()
  const dialog = page.getByRole('dialog', { name: names.opportunity })
  await dialog.getByRole('tab', { name: 'Tarefa' }).click()
  const taskPanel = dialog.getByRole('tabpanel', { name: 'Tarefa' })
  await taskPanel.getByLabel('Título').fill('Enviar proposta')
  await taskPanel.getByLabel('Lembrar em').fill(localInput(new Date()))
  await taskPanel.getByRole('button', { name: 'Criar tarefa' }).click()
  await page.getByText('Tarefa criada.').waitFor()
  await dialog.getByRole('tab', { name: 'Nota' }).click()
  await dialog.getByRole('tabpanel', { name: 'Nota' }).getByRole('textbox', { name: 'Nota' }).fill('Cliente pediu desconto de 5%.')
  await dialog.getByRole('button', { name: 'Registrar nota' }).click()
  await dialog.locator('.crm-timeline').getByText('Cliente pediu desconto de 5%.').waitFor()
  await dialog.locator('.crm-timeline').getByText('Tarefa · Enviar proposta').waitFor()
  await dialog.getByRole('button', { name: 'Fechar janela' }).click()

  await page.getByRole('link', { name: 'Minha agenda' }).click()
  await page.getByRole('heading', { name: 'Minha agenda', exact: true }).waitFor()
  await page.getByRole('link', { name: 'Enviar proposta' }).first().waitFor()
  evidence.steps.push({ step: 'agenda', task: 'Enviar proposta' })

  // --- convert into a quote, accepted in Sales -----------------------------------------------
  await page.getByRole('link', { name: 'Funil de vendas' }).click()
  await chooseOption(page, page.getByRole('combobox', { name: 'Funil', exact: true }), names.pipeline)
  await oppCard().click()
  await dialog.getByRole('button', { name: 'Converter em orçamento' }).click()
  const convert = page.getByRole('dialog', { name: `Converter ${names.opportunity} em orçamento` })
  await chooseOption(page, convert.getByRole('combobox', { name: 'Item 1' }), fixture.itemName)
  await convert.getByRole('button', { name: 'Converter em orçamento' }).click()
  await convert.getByText('Orçamento criado — concluído').waitFor({ timeout: 60_000 })
  await convert.getByRole('link', { name: 'Abrir o orçamento' }).click()
  await page.waitForURL(/\/app\/sales\/quotes\?open=/)
  const quote = page.getByRole('dialog', { name: /^Orçamento QT-/ })
  await quote.getByRole('button', { name: 'Enviar ao cliente' }).click()
  await quote.getByRole('button', { name: 'Cliente aceitou' }).click()
  await quote.getByText('aceito').first().waitFor()
  await quote.getByRole('button', { name: 'Fechar janela' }).click()

  await page.goto(`${appUrl}/app/crm/pipeline?open=${opportunityId}`, { waitUntil: 'domcontentloaded' })
  await eventually(page, async () => {
    const won = page.getByRole('dialog', { name: names.opportunity })
    await won.waitFor()
    if ((await won.getByText(/^Ganha pelo orçamento aceito QT-/).count()) === 1) return true
    await page.reload({ waitUntil: 'domcontentloaded' })
    return false
  })
  const won = page.getByRole('dialog', { name: names.opportunity })
  await won.getByText('Uma oportunidade ganha por orçamento aceito não é reaberta; abra uma nova para dar sequência.').waitFor()
  await won.locator('.crm-timeline').getByText('Convertida por orçamento aceito').waitFor()
  await won.getByRole('button', { name: 'Fechar janela' }).click()
  const attribution = await api('GET', `/crm/opportunities/${opportunityId}`)
  const quoteId = attribution.conversion.quoteId
  const accepted = await api('GET', `/sales/quotes/${quoteId}`)
  assert(accepted.attribution?.opportunityId === opportunityId, 'the quote names the opportunity')
  assert(accepted.attribution?.sourceId === attribution.sourceId, 'the quote kept the source')
  assert(accepted.attribution?.ownerId === attribution.ownerId, 'the quote kept the owner')
  evidence.steps.push({ step: 'conversion', quoteId, status: attribution.status, attribution: accepted.attribution })

  // --- forecast and metrics --------------------------------------------------------------------
  await page.getByRole('link', { name: 'Previsão e métricas' }).click()
  await page.getByRole('heading', { name: 'Previsão e métricas', exact: true }).waitFor()
  await chooseOption(page, page.getByRole('combobox', { name: 'Métricas de' }), names.pipeline)
  await page.getByRole('button', { name: 'Atualizar' }).click()
  const metrics = page.getByRole('region', { name: 'Métricas do funil' })
  await metrics.getByText('Taxa de ganho').waitFor()
  // The chosen pipeline's own stages: the drag and the arrow keys moved it both ways.
  await metrics.getByText('Qualificação → Proposta · 2').waitFor()
  await metrics.getByText('Proposta → Qualificação · 1').waitFor()
  evidence.steps.push({ step: 'forecast', read: true })

  // --- the same screens in English ---------------------------------------------------------------
  await setLanguage(page, 'English')
  for (const [link, heading] of [
    ['Pipeline', 'Pipeline'],
    ['Accounts', 'Accounts'],
    ['My agenda', 'My agenda'],
    ['Forecast and metrics', 'Forecast and metrics'],
    ['CRM settings', 'CRM settings'],
  ]) {
    await page.getByRole('link', { name: link, exact: true }).click()
    await page.getByRole('heading', { name: heading, exact: true }).waitFor()
  }
  await page.goto(`${appUrl}/app/crm/pipeline?open=${opportunityId}`, { waitUntil: 'domcontentloaded' })
  const english = page.getByRole('dialog', { name: names.opportunity })
  await english.getByText(/^Won by the accepted quote QT-/).waitFor()
  await english.getByRole('heading', { name: 'Timeline' }).waitFor()
  await english.getByRole('button', { name: 'Close dialog' }).click()
  evidence.steps.push({ step: 'english', screens: 5 })
  await setLanguage(page, 'Português (Brasil)')

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  const shot = join(process.env.HORIZON_SCREENSHOT_DIR ?? '/tmp', 'crm-workflow-failure.png')
  await browser
    .contexts()[0]
    ?.pages()[0]
    ?.screenshot({ path: shot, fullPage: true })
    .catch(() => undefined)
  console.error(`screenshot: ${shot}`)
  throw error
} finally {
  await browser.close()
}

/** The operator gets `crm:admin`; a priced item in Sales is what the quote will offer. */
async function prepare() {
  let cursor
  let operator
  do {
    const page = await api('GET', `/identity/users?limit=100${cursor ? `&cursor=${cursor}` : ''}`)
    operator = page.data.find((user) => user.email === email)
    cursor = page.page?.hasMore ? page.page.nextCursor : undefined
  } while (!operator && cursor)
  if (!operator) throw new Error(`No user ${email} in the workspace`)
  if (!operator.roles.some((role) => role.module === 'crm' && role.role === 'admin'))
    await api('POST', `/identity/users/${operator.id}/roles`, { operation: 'grant', assignment: { module: 'crm', role: 'admin' } })
  const row = execFileSync(
    'docker',
    [
      'exec',
      'horizon-postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'horizon_sales',
      '-At',
      '-c',
      `select item_id || '|' || description from catalog_items where tenant_id = '${tenantId}' and active = 1 and currency = 'BRL' and unit_price > 0 and coalesce(kind, 'product') = 'product' order by item_id limit 1`,
    ],
    { encoding: 'utf8' },
  ).trim()
  const [itemId, itemName] = row.split('|')
  if (!itemId) throw new Error('No priced product in Sales')
  return { operatorId: operator.id, itemId, itemName }
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
      ...['identity:owner', 'crm:admin', 'sales:admin'].flatMap((role) => ['--role', role]),
    ],
    { encoding: 'utf8' },
  ).trim()
  return async (method, path, body) => {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
}

async function addEntry(page, section, name) {
  const block = page.getByRole('region', { name: section, exact: true })
  await block.getByRole('textbox', { name: 'Nome' }).first().fill(name)
  await block.getByRole('button', { name: 'Adicionar', exact: true }).click()
  await page.waitForFunction(
    ({ label, value }) =>
      [...document.querySelectorAll(`section[aria-label="${label}"] input`)].some((input) => input.value === value),
    { label: section, value: name },
  )
}

/** Retries a check that depends on the broker, reopening the screen. */
async function eventually(page, probe, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return
    await page.waitForTimeout(2_000)
  }
  throw new Error('Timed out waiting for the screen to show the downstream effect')
}

function localInput(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function nextMonthDay() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15)).toISOString().slice(0, 10)
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
