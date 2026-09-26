import jsQR from 'jsqr'
import { decodePDFRawStream, PDFArray, PDFDocument, type PDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { qrModules, renderSimulatedDanfeNfce } from './danfe'
import { nfceFixture } from './spec-fixture'
import { serializeNfce65 } from './xml'

const protocol = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    simulated: true,
    protocolNumber: '135260000000001',
    authorizedAt: '2026-09-26T13:15:30.000Z',
  }),
)

describe('DANFE NFC-e (manual v6.0)', () => {
  it('draws a QR image that decodes to the XML qrCode', async () => {
    const xml = serializeNfce65(nfceFixture())
    const pdf = await renderSimulatedDanfeNfce({ signedXml: xml, state: 'authorized', protocol })
    const stream = await pageStream(pdf)
    expect(decodeDrawnQr(stream)).toBe(nfceFixture().supplement.qrCode)
    // The module matrix itself decodes too, and is error correction level M.
    expect(decodeMatrix(qrModules(nfceFixture().supplement.qrCode))).toBe(
      nfceFixture().supplement.qrCode,
    )
  })

  it('prints every division and the simulation notice on an 80 mm roll', async () => {
    const xml = serializeNfce65(nfceFixture())
    const pdf = await renderSimulatedDanfeNfce({ signedXml: xml, state: 'authorized', protocol })
    const document = await PDFDocument.load(pdf)
    expect(document.getPageCount()).toBe(1)
    expect(Math.round((document.getPages()[0]?.getWidth() ?? 0) / (72 / 25.4))).toBe(80)
    expect(document.getTitle()).toContain('SEM VALOR FISCAL')
    const stream = await pageStream(pdf)
    for (const text of [
      'CNPJ: 00.000.000/E08G-12',
      'Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica',
      'CAFE-001  Café torrado em grãos',
      'Qtde. total de itens',
      'Crédito Loja',
      'Consulte pela Chave de Acesso em',
      'https://nfce.simulacao.horizon.invalid/consulta',
      nfceFixture().accessKey.match(/.{4}/g)?.join(' ') ?? '',
      'CONSUMIDOR CPF: 123.456.789-09',
      'Consumidora Simulada',
      'NFC-e nº 000000001  Série 001  26/09/2026 10:15:00',
      'Protocolo de autorização: 135260000000001',
      // 13:15:30Z at the emission's -03:00 offset
      'Data de autorização: 26/09/2026 10:15:30',
      'EMITIDA EM AMBIENTE DE SIMULAÇÃO',
      '– SEM VALOR FISCAL –',
    ])
      expect(stream, text).toContain(hex(text))
    expect(stream).not.toContain(hex('NÃO AUTORIZADA'))
    // No discount or additions: those lines and "Valor a pagar" are omitted.
    expect(stream).not.toContain(hex('Valor a pagar'))
  })

  it('marks a preview as not authorized and an anonymous sale as unidentified', async () => {
    const preview = await renderSimulatedDanfeNfce({
      signedXml: serializeNfce65({ ...nfceFixture(), presence: '1', consumer: null }),
      state: 'preview',
    })
    const stream = await pageStream(preview)
    expect(stream).toContain(hex('NÃO AUTORIZADA'))
    expect(stream).toContain(hex('CONSUMIDOR NÃO IDENTIFICADO'))
    expect(stream).toContain(hex('documento não autorizado'))
    expect(
      await renderSimulatedDanfeNfce({
        signedXml: serializeNfce65({ ...nfceFixture(), presence: '1', consumer: null }),
        state: 'preview',
      }),
    ).toEqual(preview)
  })

  it('refuses an authorized print without protocol and a model 55 document', async () => {
    const xml = serializeNfce65(nfceFixture())
    await expect(renderSimulatedDanfeNfce({ signedXml: xml, state: 'authorized' })).rejects.toThrow(
      'recorded protocol',
    )
    await expect(
      renderSimulatedDanfeNfce({
        signedXml: Buffer.from(xml.toString().replace('<mod>65</mod>', '<mod>55</mod>')),
        state: 'preview',
      }),
    ).rejects.toThrow('model 65')
  })
})

async function pageStream(pdf: Buffer): Promise<string> {
  const document = await PDFDocument.load(pdf)
  const contents = document.getPages()[0]?.node.Contents()
  if (!contents) throw new Error('page has no content')
  const references = contents instanceof PDFArray ? contents.asArray() : [contents]
  return references
    .map((reference) =>
      Buffer.from(
        decodePDFRawStream(document.context.lookup(reference as never) as PDFRawStream).decode(),
      ).toString('latin1'),
    )
    .join('\n')
}

/** WinAnsi hex, as pdf-lib writes text with the standard fonts. */
function hex(text: string): string {
  return Buffer.from(text.replaceAll('–', '\x96'), 'latin1').toString('hex').toUpperCase()
}

/** Rebuilds the module grid from the filled squares in the page and decodes it. */
function decodeDrawnQr(stream: string): string | null {
  const squares = [
    ...stream.matchAll(
      /1 0 0 1 ([\d.]+) ([\d.]+) cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n0 0 m\n0 ([\d.]+) l/g,
    ),
  ].map((match) => ({ x: Number(match[1]), y: Number(match[2]), size: Number(match[3]) }))
  if (squares.length === 0) return null
  const size = squares[0]?.size ?? 1
  const left = Math.min(...squares.map((square) => square.x))
  const top = Math.max(...squares.map((square) => square.y))
  const cells = squares.map((square) => ({
    column: Math.round((square.x - left) / size),
    row: Math.round((top - square.y) / size),
  }))
  const dimension = Math.max(...cells.flatMap((cell) => [cell.column, cell.row])) + 1
  const matrix = Array.from({ length: dimension }, () =>
    Array.from({ length: dimension }, () => false),
  )
  for (const cell of cells) {
    const row = matrix[cell.row]
    if (row) row[cell.column] = true
  }
  return decodeMatrix(matrix)
}

function decodeMatrix(matrix: boolean[][]): string | null {
  const scale = 4
  const quiet = 4
  const width = (matrix.length + 2 * quiet) * scale
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255)
  for (const [row, columns] of matrix.entries())
    for (const [column, dark] of columns.entries()) {
      if (!dark) continue
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const offset = (((row + quiet) * scale + dy) * width + (column + quiet) * scale + dx) * 4
          pixels[offset] = 0
          pixels[offset + 1] = 0
          pixels[offset + 2] = 0
        }
    }
  return jsQR(pixels, width, width)?.data ?? null
}
