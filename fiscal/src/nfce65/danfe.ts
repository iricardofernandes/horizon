import { createHash } from 'node:crypto'
import { DOMParser, type Element } from '@xmldom/xmldom'
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib'
import QRCode from 'qrcode'
import { z } from 'zod'

const MM = 72 / 25.4
const PAGE_WIDTH = 80 * MM
const MARGIN = 3 * MM
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN
/** QR content 28 mm with a 3.5 mm quiet zone per side: 35 mm, above the 25 mm minimum. */
const QR_CONTENT = 28 * MM
const QR_QUIET_ZONE = 3.5 * MM
const MAX_PAGE_HEIGHT = 14_000
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z')

/** Mirrors the mandatory homologation text (manual §3.1.8), one phrase per line. */
const SIMULATION_NOTICE = ['EMITIDA EM AMBIENTE DE SIMULAÇÃO', '– SEM VALOR FISCAL –'] as const
const PAYMENT_LABELS: Record<string, string> = {
  '01': 'Dinheiro',
  '02': 'Cheque',
  '05': 'Crédito Loja',
  '15': 'Boleto Bancário',
  '16': 'Depósito Bancário',
  '18': 'Transferência bancária, Carteira Digital',
}

const protocolSchema = z.object({
  protocolNumber: z.string().regex(/^[0-9]{15}$/),
  authorizedAt: z.iso.datetime(),
})

type Block =
  | { type: 'text'; text: string; size: number; bold?: boolean; align?: 'left' | 'center' }
  | { type: 'pair'; left: string; right: string; size: number; bold?: boolean }
  | { type: 'rule' }
  | { type: 'gap'; height: number }
  | { type: 'qr'; modules: boolean[][] }

/**
 * The DANFE NFC-e of a simulated model 65 document, following the divisions of the
 * "Manual de Padrões Técnicos do DANFE NFC-e e QR Code" v6.0. It is always marked as a
 * simulation without fiscal value; a preview also says it is not authorized.
 */
export async function renderSimulatedDanfeNfce(input: {
  signedXml: Buffer
  state: 'preview' | 'authorized'
  protocol?: Buffer
}): Promise<Buffer> {
  if (input.signedXml.length === 0 || input.signedXml.length > 10 * 1024 * 1024)
    throw new Error('DANFE NFC-e signed XML size is invalid')
  if (input.state === 'authorized' && !input.protocol)
    throw new Error('Authorized DANFE NFC-e requires a recorded protocol')
  const facts = readFacts(input.signedXml)
  const protocol = input.protocol
    ? protocolSchema.parse(JSON.parse(input.protocol.toString('utf8')))
    : null
  const blocks = layout(facts, input.state, protocol, input.signedXml)
  const pdf = await PDFDocument.create({ updateMetadata: false })
  pdf.setTitle('DANFE NFC-e de simulação - modelo 65 - SEM VALOR FISCAL')
  pdf.setAuthor('Horizon Fiscal')
  pdf.setCreationDate(FIXED_DATE)
  pdf.setModificationDate(FIXED_DATE)
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  }
  for (const pageBlocks of paginate(blocks, fonts)) draw(pdf, pageBlocks, fonts)
  return Buffer.from(await pdf.save({ useObjectStreams: false }))
}

/** The dark modules of the QR code image, error correction level M (manual §4.5.2). */
export function qrModules(text: string): boolean[][] {
  const code = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const size = code.modules.size
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => Boolean(code.modules.get(row, column))),
  )
}

type Facts = ReturnType<typeof readFacts>

function optional(parent: Element, name: string): string | null {
  return parent.getElementsByTagName(name).item(0)?.textContent?.trim() || null
}

function required(parent: Element, name: string): string {
  const value = optional(parent, name)
  if (!value) throw new Error(`DANFE NFC-e signed XML lacks ${name}`)
  return value
}

function readFacts(signedXml: Buffer) {
  const xml = new DOMParser().parseFromString(signedXml.toString('utf8'), 'application/xml')
  const root = xml.documentElement
  const inf = xml.getElementsByTagName('infNFe').item(0)
  const issuer = xml.getElementsByTagName('emit').item(0)
  const total = xml.getElementsByTagName('ICMSTot').item(0)
  const supplement = xml.getElementsByTagName('infNFeSupl').item(0)
  if (!root || !inf || !issuer || !total || !supplement)
    throw new Error('DANFE NFC-e XML is incomplete')
  if (required(inf, 'mod') !== '65') throw new Error('DANFE NFC-e needs a model 65 document')
  const key = inf.getAttribute('Id')?.replace(/^NFe/, '')
  if (!key || !/^[0-9A-Z]{44}$/.test(key)) throw new Error('DANFE NFC-e access key is invalid')
  const issuerAddress = issuer.getElementsByTagName('enderEmit').item(0)
  if (!issuerAddress) throw new Error('DANFE NFC-e XML lacks enderEmit')
  const consumer = xml.getElementsByTagName('dest').item(0)
  const consumerAddress = consumer?.getElementsByTagName('enderDest').item(0) ?? null
  return {
    key,
    series: required(inf, 'serie'),
    number: required(inf, 'nNF'),
    issuedAt: required(inf, 'dhEmi'),
    issuer: {
      taxId: required(issuer, 'CNPJ'),
      name: required(issuer, 'xNome'),
      address: formatAddress(issuerAddress),
    },
    consumer: consumer
      ? {
          cpf: optional(consumer, 'CPF'),
          cnpj: optional(consumer, 'CNPJ'),
          name: optional(consumer, 'xNome'),
          address: consumerAddress ? formatAddress(consumerAddress) : null,
        }
      : null,
    items: Array.from(xml.getElementsByTagName('prod')).map((product) => ({
      code: required(product, 'cProd'),
      description: required(product, 'xProd'),
      quantity: required(product, 'qCom'),
      unit: required(product, 'uCom'),
      unitPrice: required(product, 'vUnCom'),
      total: required(product, 'vProd'),
    })),
    totals: {
      products: required(total, 'vProd'),
      discount: required(total, 'vDesc'),
      additions: ['vFrete', 'vSeg', 'vOutro']
        .map((name) => cents(required(total, name)))
        .reduce((sum, value) => sum + value, 0n),
      invoice: required(total, 'vNF'),
      change: optional(root, 'vTroco'),
    },
    payments: Array.from(xml.getElementsByTagName('detPag')).map((detail) => ({
      method: required(detail, 'tPag'),
      amount: required(detail, 'vPag'),
    })),
    qrCode: required(supplement, 'qrCode'),
    keyQueryUrl: required(supplement, 'urlChave'),
  }
}

function formatAddress(node: Element): string {
  const complement = optional(node, 'xCpl')
  return [
    `${required(node, 'xLgr')}, ${required(node, 'nro')}${complement ? ` ${complement}` : ''}`,
    required(node, 'xBairro'),
    `${required(node, 'xMun')} - ${required(node, 'UF')}`,
  ].join(', ')
}

function layout(
  facts: Facts,
  state: 'preview' | 'authorized',
  protocol: z.infer<typeof protocolSchema> | null,
  signedXml: Buffer,
): Block[] {
  const blocks: Block[] = []
  const text = (value: string, size = 7, extra: Partial<Extract<Block, { type: 'text' }>> = {}) =>
    blocks.push({ type: 'text', text: value, size, ...extra })
  // Division I — header
  text(`CNPJ: ${formatCnpj(facts.issuer.taxId)}`, 7, { align: 'center' })
  text(facts.issuer.name, 8, { bold: true, align: 'center' })
  text(facts.issuer.address, 7, { align: 'center' })
  text('Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica', 7, { align: 'center' })
  if (state === 'preview') text('NÃO AUTORIZADA', 11, { bold: true, align: 'center' })
  blocks.push({ type: 'rule' })
  // Division II — items
  blocks.push({
    type: 'pair',
    left: 'Código  Descrição',
    right: 'Valor total',
    size: 6.5,
    bold: true,
  })
  blocks.push({ type: 'pair', left: 'Qtde  Un  x  Valor unit.', right: '', size: 6.5, bold: true })
  for (const item of facts.items) {
    text(`${item.code}  ${item.description}`, 7)
    blocks.push({
      type: 'pair',
      left: `${formatQuantity(item.quantity)}  ${item.unit}  x  ${formatMoney(item.unitPrice)}`,
      right: formatMoney(item.total),
      size: 7,
    })
  }
  blocks.push({ type: 'rule' })
  // Division III — totals and payment
  const pair = (left: string, right: string, bold = false) =>
    blocks.push({ type: 'pair', left, right, size: 7.5, bold })
  pair('Qtde. total de itens', String(facts.items.length))
  pair('Valor total R$', formatMoney(facts.totals.products))
  const discount = cents(facts.totals.discount)
  if (discount > 0n) pair('Desconto R$', formatMoney(facts.totals.discount))
  if (facts.totals.additions > 0n)
    pair('Acréscimos (frete, seguro e outras despesas) R$', formatCents(facts.totals.additions))
  if (discount > 0n || facts.totals.additions > 0n)
    pair('Valor a pagar R$', formatMoney(facts.totals.invoice), true)
  pair('FORMA DE PAGAMENTO', 'VALOR PAGO R$', true)
  for (const payment of facts.payments)
    pair(PAYMENT_LABELS[payment.method] ?? `Meio ${payment.method}`, formatMoney(payment.amount))
  if (facts.totals.change) pair('Troco R$', formatMoney(facts.totals.change))
  blocks.push({ type: 'rule' })
  // Division IV — consultation by access key
  text('Consulte pela Chave de Acesso em', 7, { bold: true, align: 'center' })
  text(facts.keyQueryUrl, 7, { align: 'center' })
  text(facts.key.match(/.{4}/g)?.join(' ') ?? facts.key, 7, { align: 'center' })
  blocks.push({ type: 'rule' })
  // Division VI — consumer
  const consumer = facts.consumer
  if (!consumer?.cpf && !consumer?.cnpj) {
    text('CONSUMIDOR NÃO IDENTIFICADO', 7.5, { bold: true, align: 'center' })
  } else {
    const identification = consumer.cpf
      ? `CONSUMIDOR CPF: ${formatCpf(consumer.cpf)}`
      : `CONSUMIDOR CNPJ: ${formatCnpj(consumer.cnpj ?? '')}`
    text(identification, 7.5, { bold: true, align: 'center' })
    if (consumer.name) text(consumer.name, 7, { align: 'center' })
    if (consumer.address) text(consumer.address, 7, { align: 'center' })
  }
  // Division VII — identification and authorization protocol
  text(
    `NFC-e nº ${facts.number.padStart(9, '0')}  Série ${facts.series.padStart(3, '0')}  ${formatLocal(facts.issuedAt)}`,
    7.5,
    { bold: true, align: 'center' },
  )
  if (protocol) {
    text(`Protocolo de autorização: ${protocol.protocolNumber}`, 7, { align: 'center' })
    text(
      `Data de autorização: ${formatLocal(atOffset(protocol.authorizedAt, facts.issuedAt))}`,
      7,
      { align: 'center' },
    )
  } else {
    text('Protocolo de autorização: não há — documento não autorizado', 7, { align: 'center' })
  }
  // Division V — QR code, centered (manual figure 5)
  blocks.push({ type: 'gap', height: 4 })
  blocks.push({ type: 'qr', modules: qrModules(facts.qrCode) })
  // Division VIII — fiscal message area
  blocks.push({ type: 'rule' })
  for (const line of SIMULATION_NOTICE) text(line, 7.5, { bold: true, align: 'center' })
  text(`XML SHA-256: ${createHash('sha256').update(signedXml).digest('hex')}`, 5, {
    align: 'center',
  })
  return blocks
}

type Fonts = { regular: PDFFont; bold: PDFFont }

function blockHeight(block: Block, fonts: Fonts): number {
  if (block.type === 'rule') return 6
  if (block.type === 'gap') return block.height
  if (block.type === 'qr') return QR_CONTENT + 2 * QR_QUIET_ZONE
  if (block.type === 'pair') return block.size + 3
  const font = block.bold ? fonts.bold : fonts.regular
  return wrap(safe(block.text), font, block.size).length * (block.size + 2.5)
}

function paginate(blocks: Block[], fonts: Fonts): Block[][] {
  const pages: Block[][] = [[]]
  let height = 0
  for (const block of blocks) {
    const current = blockHeight(block, fonts)
    if (height + current > MAX_PAGE_HEIGHT - 2 * MARGIN && (pages.at(-1)?.length ?? 0) > 0) {
      pages.push([])
      height = 0
    }
    pages.at(-1)?.push(block)
    height += current
  }
  return pages
}

function draw(pdf: PDFDocument, blocks: Block[], fonts: Fonts): void {
  const height = blocks.reduce((sum, block) => sum + blockHeight(block, fonts), 0) + 2 * MARGIN + 12
  const page = pdf.addPage([PAGE_WIDTH, height])
  let y = height - MARGIN
  for (const block of blocks) {
    const blockSize = blockHeight(block, fonts)
    if (block.type === 'rule') {
      page.drawLine({
        start: { x: MARGIN, y: y - 3 },
        end: { x: PAGE_WIDTH - MARGIN, y: y - 3 },
        thickness: 0.4,
        color: rgb(0, 0, 0),
        dashArray: [2, 2],
      })
    } else if (block.type === 'qr') {
      drawQr(page, block.modules, y)
    } else if (block.type === 'pair') {
      const font = block.bold ? fonts.bold : fonts.regular
      const right = safe(block.right)
      const rightWidth = font.widthOfTextAtSize(right, block.size)
      const left = ellipsize(safe(block.left), font, block.size, CONTENT_WIDTH - rightWidth - 4)
      page.drawText(left, { x: MARGIN, y: y - block.size, size: block.size, font })
      page.drawText(right, {
        x: PAGE_WIDTH - MARGIN - rightWidth,
        y: y - block.size,
        size: block.size,
        font,
      })
    } else if (block.type === 'text') {
      const font = block.bold ? fonts.bold : fonts.regular
      let lineY = y
      for (const line of wrap(safe(block.text), font, block.size)) {
        const width = font.widthOfTextAtSize(line, block.size)
        const x = block.align === 'center' ? (PAGE_WIDTH - width) / 2 : MARGIN
        page.drawText(line, { x, y: lineY - block.size, size: block.size, font })
        lineY -= block.size + 2.5
      }
    }
    y -= blockSize
  }
}

/** Each dark module is one filled square; nothing else on the page is drawn with `re`. */
function drawQr(page: PDFPage, modules: boolean[][], top: number): void {
  const size = modules.length
  const module = QR_CONTENT / size
  const left = (PAGE_WIDTH - QR_CONTENT) / 2
  const upper = top - QR_QUIET_ZONE
  for (const [row, columns] of modules.entries())
    for (const [column, dark] of columns.entries())
      if (dark)
        page.drawRectangle({
          x: left + column * module,
          y: upper - (row + 1) * module,
          width: module,
          height: module,
          color: rgb(0, 0, 0),
        })
}

function wrap(text: string, font: PDFFont, size: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= CONTENT_WIDTH) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    // A single word wider than the roll (a URL) is broken by characters.
    let rest = word
    while (font.widthOfTextAtSize(rest, size) > CONTENT_WIDTH) {
      let cut = rest.length
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > CONTENT_WIDTH) cut--
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    current = rest
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

function ellipsize(text: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text
  let cut = text.length
  while (cut > 1 && font.widthOfTextAtSize(`${text.slice(0, cut)}…`, size) > width) cut--
  return `${text.slice(0, cut)}…`
}

/** Keeps what the standard fonts can encode (WinAnsi); anything else prints as `?`. */
function safe(text: string): string {
  return text.normalize('NFC').replace(/[^\x20-\x7e\xa0-\xff–—…]/g, '?')
}

function cents(value: string): bigint {
  const [integer = '0', fraction = ''] = value.split('.')
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
}

function formatCents(value: bigint): string {
  const integer = (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${integer},${(value % 100n).toString().padStart(2, '0')}`
}

function formatMoney(value: string): string {
  return formatCents(cents(value))
}

function formatQuantity(value: string): string {
  const [integer = '0', fraction = ''] = value.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  return trimmed ? `${integer},${trimmed}` : integer
}

function formatCnpj(value: string): string {
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(value)) return value
  return `${value.slice(0, 2)}.${value.slice(2, 5)}.${value.slice(5, 8)}/${value.slice(8, 12)}-${value.slice(12)}`
}

function formatCpf(value: string): string {
  if (!/^\d{11}$/.test(value)) return value
  return `${value.slice(0, 3)}.${value.slice(3, 6)}.${value.slice(6, 9)}-${value.slice(9)}`
}

/** `dhEmi` already carries the local offset; print it as dd/mm/yyyy hh:mm:ss. */
function formatLocal(instant: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/.exec(instant)
  if (!match) throw new Error('DANFE NFC-e instant is invalid')
  return `${match[3]}/${match[2]}/${match[1]} ${match[4]}`
}

/** Moves a UTC instant to the offset of the emission, as the manual prints local time. */
function atOffset(utc: string, reference: string): string {
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(reference)
  if (!offset?.[1] || !offset[2] || !offset[3]) throw new Error('DANFE NFC-e offset is invalid')
  const minutes = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]))
  const shifted = new Date(Date.parse(utc) + minutes * 60_000).toISOString().slice(0, 19)
  return `${shifted}${offset[0]}`
}
