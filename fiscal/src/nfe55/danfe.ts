import { createHash } from 'node:crypto'
import { DOMParser } from '@xmldom/xmldom'
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib'

type DanfeState = 'preview' | 'authorized'

/** A deterministic simulation summary derived from immutable signed XML and observation bytes. */
export async function renderSimulatedDanfe(input: {
  signedXml: Buffer
  state: DanfeState
  protocol?: Buffer
}): Promise<Buffer> {
  if (input.signedXml.length === 0 || input.signedXml.length > 10 * 1024 * 1024)
    throw new Error('DANFE signed XML size is invalid')
  if (input.state === 'authorized' && !input.protocol)
    throw new Error('Authorized DANFE requires a recorded protocol')
  const xml = new DOMParser().parseFromString(input.signedXml.toString('utf8'), 'application/xml')
  const first = (
    parent: {
      getElementsByTagName(name: string): {
        item(index: number): { textContent: string | null } | null
      }
    },
    name: string,
  ): string => {
    const node = parent.getElementsByTagName(name).item(0)
    if (!node?.textContent) throw new Error(`DANFE signed XML lacks ${name}`)
    return node.textContent.trim()
  }
  const inf = xml.getElementsByTagName('infNFe').item(0)
  if (!inf) throw new Error('DANFE signed XML lacks infNFe')
  const key = inf.getAttribute('Id')?.replace(/^NFe/, '')
  if (!key || !/^[0-9A-Z]{44}$/.test(key)) throw new Error('DANFE access key is invalid')
  const issuer = xml.getElementsByTagName('emit').item(0)
  const recipient = xml.getElementsByTagName('dest').item(0)
  const total = xml.getElementsByTagName('ICMSTot').item(0)
  if (!issuer || !recipient || !total) throw new Error('DANFE signed XML is incomplete')
  const details = Array.from(xml.getElementsByTagName('det'))
  const rows = details.map((detail) => {
    const product = detail.getElementsByTagName('prod').item(0)
    if (!product) throw new Error('DANFE signed XML has an incomplete line')
    return `${first(product, 'cProd')}  ${first(product, 'xProd')}  ${first(product, 'qCom')} x ${first(product, 'vUnCom')} = ${first(product, 'vProd')}`
  })
  const lines = [
    `Chave: ${key}`,
    `NF-e 55  Série ${first(inf, 'serie')}  Número ${first(inf, 'nNF')}  Emissão ${first(inf, 'dhEmi')}`,
    `Emitente: ${first(issuer, 'xNome')}  CNPJ ${first(issuer, 'CNPJ')}`,
    `Destinatário: ${first(recipient, 'xNome')}  CNPJ ${first(recipient, 'CNPJ')}`,
    `Total dos produtos: R$ ${first(total, 'vProd')}`,
    `Total da nota: R$ ${first(total, 'vNF')}`,
    `XML SHA-256: ${createHash('sha256').update(input.signedXml).digest('hex')}`,
    ...(input.protocol
      ? [`Protocolo simulado SHA-256: ${createHash('sha256').update(input.protocol).digest('hex')}`]
      : []),
    '',
    'Itens',
    ...rows,
  ]
  const pdf = await PDFDocument.create({ updateMetadata: false })
  const fixedDate = new Date('2026-01-01T00:00:00.000Z')
  pdf.setTitle('DANFE de simulação - NF-e modelo 55')
  pdf.setAuthor('Horizon Fiscal')
  pdf.setCreationDate(fixedDate)
  pdf.setModificationDate(fixedDate)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const perPage = 43
  const pageCount = Math.max(1, Math.ceil(lines.length / perPage))
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const page = pdf.addPage([595.28, 841.89])
    page.drawText('DANFE — NF-e 55 — AMBIENTE DE SIMULAÇÃO', {
      x: 32,
      y: 800,
      size: 13,
      font: bold,
    })
    page.drawText('SIMULAÇÃO — SEM VALOR FISCAL', {
      x: 42,
      y: 450,
      size: 30,
      font: bold,
      color: rgb(0.88, 0.7, 0.7),
      rotate: degrees(35),
      opacity: 0.6,
    })
    if (input.state === 'preview')
      page.drawText('NÃO AUTORIZADA', {
        x: 180,
        y: 725,
        size: 20,
        font: bold,
        color: rgb(0.75, 0.1, 0.1),
      })
    else
      page.drawText('AUTORIZAÇÃO SIMULADA', {
        x: 160,
        y: 725,
        size: 18,
        font: bold,
        color: rgb(0.1, 0.35, 0.1),
      })
    for (const [index, line] of lines
      .slice(pageIndex * perPage, (pageIndex + 1) * perPage)
      .entries())
      page.drawText(
        line
          .normalize('NFKD')
          .replace(/\p{M}/gu, '')
          .replace(/[^\x20-\x7e]/g, '?')
          .slice(0, 110),
        { x: 32, y: 690 - index * 14, size: 8, font },
      )
    page.drawText(`Página ${pageIndex + 1} de ${pageCount} — SIMULAÇÃO — SEM VALOR FISCAL`, {
      x: 32,
      y: 25,
      size: 8,
      font: bold,
    })
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }))
}
