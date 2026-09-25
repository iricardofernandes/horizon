import { decodePDFRawStream, PDFArray, PDFDocument, type PDFRawStream } from 'pdf-lib'
import { expect, it } from 'vitest'
import { renderHomologationDanfe, renderSimulatedDanfe } from './danfe'

const signedXml = Buffer.from(
  `<NFe><infNFe Id="NFe${'1'.repeat(44)}"><ide><serie>1</serie><nNF>42</nNF><dhEmi>2026-09-22T12:00:00-03:00</dhEmi></ide><emit><CNPJ>11111111111111</CNPJ><xNome>Emitente</xNome></emit><dest><CNPJ>22222222222222</CNPJ><xNome>Destinatario</xNome></dest><det><prod><cProd>A</cProd><xProd>Cafe</xProd><qCom>1</qCom><vUnCom>10.00</vUnCom><vProd>10.00</vProd></prod></det><total><ICMSTot><vProd>10.00</vProd><vNF>10.00</vNF></ICMSTot></total></infNFe></NFe>`,
)

it('renders deterministic simulation PDFs and distinguishes preview from authorization', async () => {
  const preview = await renderSimulatedDanfe({ signedXml, state: 'preview' })
  const repeated = await renderSimulatedDanfe({ signedXml, state: 'preview' })
  expect(preview).toEqual(repeated)
  const authorized = await renderSimulatedDanfe({
    signedXml,
    state: 'authorized',
    protocol: Buffer.from('{"outcome":"authorized"}'),
  })
  expect(authorized).not.toEqual(preview)
  expect((await PDFDocument.load(preview)).getPageCount()).toBe(1)
  expect((await PDFDocument.load(authorized)).getPageCount()).toBe(1)
  await expect(renderSimulatedDanfe({ signedXml, state: 'authorized' })).rejects.toThrow(
    'recorded protocol',
  )
})

it('marks every homologation PDF page as having no fiscal value', async () => {
  const protocol = Buffer.from(
    '<protNFe><infProt><nProt>123456789012345</nProt></infProt></protNFe>',
  )
  const first = await renderHomologationDanfe({ signedXml, protocol })
  expect(await renderHomologationDanfe({ signedXml, protocol })).toEqual(first)
  expect(first).not.toEqual(
    await renderSimulatedDanfe({ signedXml, state: 'authorized', protocol }),
  )
  const document = await PDFDocument.load(first)
  expect(document.getTitle()).toContain('SEM VALOR FISCAL')
  const repeatedItems = signedXml
    .toString()
    .replace(
      '</det>',
      `</det>${'<det><prod><cProd>A</cProd><xProd>Cafe</xProd><qCom>1</qCom><vUnCom>10.00</vUnCom><vProd>10.00</vProd></prod></det>'.repeat(50)}`,
    )
  const multiple = await PDFDocument.load(
    await renderHomologationDanfe({ signedXml: Buffer.from(repeatedItems), protocol }),
  )
  expect(multiple.getPageCount()).toBe(2)
  expect(multiple.getTitle()).toContain('SEM VALOR FISCAL')
  const watermarkHex = Buffer.from('SEM VALOR FISCAL').toString('hex').toUpperCase()
  for (const page of multiple.getPages()) {
    const contents = page.node.Contents()
    expect(contents).toBeInstanceOf(PDFArray)
    const streams = (contents as PDFArray).asArray()
    const decoded = streams.map((ref) =>
      Buffer.from(decodePDFRawStream(multiple.context.lookup(ref) as PDFRawStream).decode())
        .toString('latin1')
        .toUpperCase(),
    )
    expect(decoded.some((content) => content.includes(watermarkHex))).toBe(true)
  }
})
