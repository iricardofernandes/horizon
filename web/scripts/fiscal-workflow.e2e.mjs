/**
 * Phase 48 browser workflow for the Fiscal screens, against the local stack.
 *
 * It signs in as the workspace's fiscal operator and walks the operator's work in pt-BR and
 * then in English: the worklist and one authorized NF-e (simulation label, timeline,
 * calculation sources, an artifact downloaded and checked against its digest), a supplier
 * XML imported through the form, a rule preview, and the support page with the capability
 * matrix and the NFS-e registry answer for an unsupported municipality.
 *
 *   node scripts/fiscal-workflow.e2e.mjs
 *     [HORIZON_WEB_URL, HORIZON_FISCAL_OPERATOR_EMAIL, HORIZON_FISCAL_WORKSPACE,
 *      HORIZON_FISCAL_TENANT, HORIZON_DEMO_PASSWORD, CHROMIUM_PATH]
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const appUrl = process.env.HORIZON_WEB_URL ?? 'http://localhost:3000'
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

const supplierXml = await supplierInvoice()
const serviceProposal = await acceptedServiceProposal()
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const evidence = { checkedAt: new Date().toISOString(), workspace, steps: [] }
try {
  const context = await browser.newContext({
    locale: 'pt-BR',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  })
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

  // --- the worklist and one authorized NF-e ----------------------------------------------
  await page.getByRole('link', { name: 'Documentos emitidos' }).click()
  await page.getByRole('heading', { name: 'Documentos emitidos', exact: true }).waitFor()
  await chooseOption(page, page.getByRole('combobox', { name: 'Modelo' }), 'NF-e 55')
  await chooseOption(
    page,
    page.getByRole('combobox', { name: 'Situação' }),
    'autorizado (simulado)',
  )
  const openButton = page.getByRole('button', { name: /^Abrir NF-e 55 número/ }).first()
  await openButton.waitFor()
  await openButton.click()
  const dialog = page.getByRole('dialog', { name: /^NF-e 55 número/ })
  await dialog.waitFor()
  await dialog.getByText('Simulação — sem valor fiscal').waitFor()
  await dialog.getByText('autorizado (simulado)').first().waitFor()
  assert((await dialog.getByText(/^autorizado$/).count()) === 0, 'a bare "autorizado" was shown')
  await dialog.locator('.fiscal-timeline li').first().waitFor()
  const transitions = await dialog.locator('.fiscal-timeline li').count()
  assert(transitions >= 4, `expected a full timeline, saw ${transitions} transitions`)
  await dialog.getByRole('button', { name: 'Cancelar' }).waitFor()
  await dialog.getByRole('button', { name: 'Carta de correção' }).waitFor()

  await dialog.getByRole('tab', { name: 'Cálculo' }).click()
  await dialog.getByRole('heading', { name: 'Fontes' }).waitFor()
  const explanation = await dialog.locator('.fiscal-explanation pre').textContent()
  assert(/rule .+ v\d+; source /.test(explanation ?? ''), 'the explanation names no rule source')

  await dialog.getByRole('tab', { name: 'Arquivos' }).click()
  const signedRow = dialog.locator('.fiscal-artifacts li', { hasText: 'XML assinado' }).first()
  await signedRow.waitFor()
  const shown = (await signedRow.locator('small').textContent()) ?? ''
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    signedRow.getByRole('link', { name: 'Baixar' }).click(),
  ])
  const bytes = await readFile(await download.path())
  const digest = createHash('sha256').update(bytes).digest('hex')
  assert(shown.includes(digest.slice(0, 12)), `downloaded bytes ${digest} differ from ${shown}`)
  assert(bytes.toString('utf8').includes('<tpAmb>2</tpAmb>'), 'the XML is not a test environment')
  evidence.steps.push({ step: 'document', transitions, signedXmlDigest: digest })
  await dialog.getByRole('button', { name: 'Fechar janela' }).click()

  // --- supplier XML through the form ------------------------------------------------------
  await page.getByRole('link', { name: 'XML de entrada' }).click()
  await page.getByRole('heading', { name: 'XML de entrada', exact: true }).waitFor()
  await page.getByLabel('Arquivo XML').setInputFiles({
    name: 'fornecedor.xml',
    mimeType: 'application/xml',
    buffer: supplierXml,
  })
  await page.getByRole('button', { name: 'Importar' }).click()
  const importDialog = page.getByRole('dialog', { name: 'NF-e de fornecedor' })
  await importDialog.waitFor()
  await importDialog
    .getByText('A assinatura é verificada; a situação na autoridade e a cadeia ICP-Brasil não são.')
    .waitFor()
  await importDialog.getByRole('link', { name: 'Baixar o XML original' }).waitFor()
  evidence.steps.push({ step: 'inbound', imported: true })
  await importDialog.getByRole('button', { name: 'Fechar janela' }).click()

  // --- rule preview -------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Prévia de regras' }).click()
  await page.getByRole('heading', { name: 'Prévia de regras', exact: true }).waitFor()
  await chooseOption(page, page.getByRole('combobox', { name: 'Operação' }), 'NFS-e')
  await page.getByLabel('Código de tributação nacional').fill('010101')
  await page.getByLabel('Quantidade').fill('1')
  await page.getByLabel('Preço unitário (BRL, ponto como separador decimal)').fill('1500.00')
  await page.getByRole('button', { name: 'Calcular' }).click()
  const result = page.locator('.fiscal-explanation pre')
  await result.waitFor()
  const previewText = (await result.textContent()) ?? ''
  assert(previewText.includes('ISS:'), `the preview did not explain the ISS: ${previewText}`)
  evidence.steps.push({ step: 'preview', explains: ['ISS', 'CBS', 'IBS'].filter((tax) => previewText.includes(tax)) })

  // --- support ------------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Suporte' }).click()
  await page.getByRole('heading', { name: 'Suporte', exact: true }).waitFor()
  await page.getByText('Este workspace emite só em simulação. Nenhum documento aqui tem valor fiscal.').waitFor()
  await page.getByRole('cell', { name: 'nfse-national-simulator-v1' }).waitFor()
  await page.getByLabel('Município (código IBGE)').fill('3509502')
  await page.getByRole('button', { name: 'Consultar o registro' }).click()
  await page.getByText(/^3509502: não suportado/).waitFor()
  evidence.steps.push({ step: 'support', campinas: 'unsupported' })

  // --- Phase 49: a service's fiscal profile, and a proposal that names its services --------
  await page.getByRole('link', { name: 'Perfis de serviço' }).click()
  await page.getByRole('heading', { name: 'Perfis de serviço', exact: true }).waitFor()
  const serviceRow = page.getByRole('button', { name: /^Abrir o perfil fiscal de Implantação assistida/ })
  await serviceRow.first().click()
  const profileDialog = page.getByRole('dialog', { name: 'Implantação assistida' })
  await profileDialog.waitFor()
  const revisionsBefore = await profileDialog.locator('.fiscal-list li').count()
  await profileDialog.getByLabel('Código de tributação nacional').fill('01.01.01')
  await profileDialog.getByLabel('NBS').fill('115022000')
  await profileDialog.getByLabel('Motivo (pelo menos 10 caracteres)').fill('Classificação conferida no teste de navegador')
  await profileDialog.getByRole('button', { name: 'Salvar revisão' }).click()
  await profileDialog.locator('.fiscal-list li').nth(revisionsBefore).waitFor()
  const revisionText = (await profileDialog.locator('.fiscal-list li').first().textContent()) ?? ''
  assert(revisionText.includes('010101') && revisionText.includes('115022000'), revisionText)
  evidence.steps.push({ step: 'service-profile', revisions: revisionsBefore + 1 })
  await profileDialog.getByRole('button', { name: 'Fechar janela' }).click()

  await page.getByRole('link', { name: 'Orçamentos' }).click()
  await page.getByRole('button', { name: 'Novo orçamento' }).first().click()
  const quoteDialog = page.getByRole('dialog', { name: 'Criar orçamento' })
  await quoteDialog.waitFor()
  await quoteDialog.getByRole('combobox', { name: 'Item 1' }).click()
  await page.getByRole('option', { name: /Implantação assistida .* · Serviço$/ }).first().waitFor()
  await page.keyboard.press('Escape')
  await quoteDialog.getByRole('button', { name: 'Fechar janela' }).click()
  evidence.steps.push({ step: 'proposal', serviceTagged: true })

  // --- Phase 50: an accepted proposal of services converts into a service order -----------
  await page.getByRole('button', { name: `Abrir orçamento ${serviceProposal.reference}` }).click()
  const acceptedDialog = page.getByRole('dialog', { name: new RegExp(`^Orçamento ${serviceProposal.reference}`) })
  await acceptedDialog.getByText('As linhas de serviço viram uma ordem de serviço').waitFor()
  assert((await acceptedDialog.getByLabel('Depósito').count()) === 0, 'services alone need no warehouse')
  await acceptedDialog.getByRole('button', { name: 'Gerar ordem de serviço' }).click()
  await acceptedDialog.getByText(/viraram a ordem de serviço OS-[0-9A-F]{8}/).waitFor()
  evidence.steps.push({ step: 'service-order-conversion', quote: serviceProposal.reference })
  await acceptedDialog.getByRole('button', { name: 'Fechar janela' }).click()

  // --- the same reading in English ----------------------------------------------------------
  await setLanguage(page, 'English')
  await page.getByRole('link', { name: 'Issued documents' }).click()
  await page.getByRole('heading', { name: 'Issued documents', exact: true }).waitFor()
  // The newest documents may all be NFS-e by now; the model filter finds an NF-e.
  await chooseOption(page, page.getByRole('combobox', { name: 'Model' }), 'NF-e 55')
  await page.getByRole('button', { name: /^Open NF-e 55 number/ }).first().click()
  const englishDialog = page.getByRole('dialog', { name: /^NF-e 55 number/ })
  await englishDialog.getByText('Simulation — no fiscal value').waitFor()
  evidence.steps.push({ step: 'english', label: 'Simulation — no fiscal value' })
  await englishDialog.getByRole('button', { name: 'Close dialog' }).click()
  await setLanguage(page, 'Português (Brasil)')

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await browser.close()
}

/** A signed supplier NF-e addressed to this workspace, made by the Phase 44 fixture CLI. */
async function supplierInvoice() {
  const token = execFileSync(
    process.execPath,
    [
      join(root, 'infra/scripts/mint-dev-token.mjs'),
      '--tenant',
      tenantId,
      '--sub',
      randomUUID(),
      '--role',
      'identity:admin',
    ],
    { encoding: 'utf8' },
  ).trim()
  const response = await fetch('http://localhost:8000/identity/workspace', {
    headers: { authorization: `Bearer ${token}` },
  })
  const buyerTaxId = (await response.json()).company.taxId
  const directory = await mkdtemp(join(tmpdir(), 'horizon-fiscal-workflow-'))
  try {
    const path = join(directory, 'supplier.xml')
    execFileSync(
      process.execPath,
      [
        join(root, 'fiscal/dist/phase44-supplier-invoice-cli.js'),
        '--supplier-tax-id',
        '11222333000181',
        '--recipient-tax-id',
        buyerTaxId,
        '--number',
        String(Math.floor(Math.random() * 900_000) + 1),
        '--line',
        'WEB-01|09012100|3|12.50|Café em grãos (fixture do navegador)',
        '--out',
        path,
        '--protocol',
      ],
      { env: { ...process.env, FISCAL_ALLOW_SUPPLIER_FIXTURE: 'true' } },
    )
    return await readFile(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** An accepted proposal of one priced Catalog service, made through the API (Phase 50). */
async function acceptedServiceProposal() {
  const token = execFileSync(
    process.execPath,
    [
      join(root, 'infra/scripts/mint-dev-token.mjs'),
      '--tenant',
      tenantId,
      '--sub',
      randomUUID(),
      ...['sales:admin', 'catalog:admin'].flatMap((role) => ['--role', role]),
    ],
    { encoding: 'utf8' },
  ).trim()
  const api = async (path, init = {}) => {
    const response = await fetch(`http://localhost:8000${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
    })
    return { status: response.status, body: await response.json() }
  }
  const customers = (await api('/sales/customers')).body
  const customer = customers.find((row) => row.status === 'active')
  const items = (await api('/catalog/items?limit=100')).body.data
  for (const item of items.filter((row) => row.kind === 'service' && row.active !== false)) {
    const quote = await api('/sales/quotes', {
      method: 'POST',
      body: JSON.stringify({
        customerId: customer.id,
        lines: [{ lineId: randomUUID(), itemId: item.id, quantity: '1' }],
      }),
    })
    if (quote.status >= 400) continue
    await api(`/sales/quotes/${quote.body.quoteId}/send`, { method: 'POST' })
    await api(`/sales/quotes/${quote.body.quoteId}/accept`, { method: 'POST' })
    return { quoteId: quote.body.quoteId, reference: `QT-${quote.body.quoteId.slice(-8).toUpperCase()}` }
  }
  throw new Error('No priced Catalog service to propose')
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
    await page.getByRole('option', { name: label, exact: false }).first().click()
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
