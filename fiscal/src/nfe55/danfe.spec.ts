import { PDFDocument } from 'pdf-lib'
import { expect, it } from 'vitest'
import { renderSimulatedDanfe } from './danfe'

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
