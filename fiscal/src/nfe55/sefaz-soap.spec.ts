import { expect, it } from 'vitest'
import { buildNfe55AccessKey } from './access-key'
import { parseSefazSoapResponse, serializeSefazRequest, wrapSefazSoap12 } from './sefaz-soap'

const key = buildNfe55AccessKey({
  issuerUfCode: '35',
  issuedOn: '2026-09-23',
  issuerTaxId: '00000000E08G12',
  model: '55',
  series: 1,
  number: 1,
  emissionType: 1,
  numericCode: '12345678',
})
const namespace = 'http://www.portalfiscal.inf.br/nfe'

function soap(payload: string): Buffer {
  return Buffer.from(
    `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
      `<soap12:Body><nfeAutorizacaoLoteResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">` +
      `<nfeResultMsg>${payload}</nfeResultMsg></nfeAutorizacaoLoteResponse></soap12:Body></soap12:Envelope>`,
  )
}

it('serializes stable, homologation-only service requests', () => {
  const document = Buffer.from(`<?xml version="1.0"?><NFe xmlns="${namespace}"><infNFe/></NFe>`)
  const authorization = serializeSefazRequest({
    service: 'authorization',
    lotId: '42',
    signedXml: document,
  })
  expect(authorization.toString()).toContain('<indSinc>0</indSinc><NFe')
  expect(authorization.toString()).not.toContain('<?xml')
  expect(serializeSefazRequest({ service: 'protocol', accessKey: key }).toString()).toContain(
    `<tpAmb>2</tpAmb><xServ>CONSULTAR</xServ><chNFe>${key}</chNFe>`,
  )
  expect(serializeSefazRequest({ service: 'status' }).toString()).toContain('<cUF>35</cUF>')
  expect(
    wrapSefazSoap12({
      operation: 'nfeAutorizacaoLote',
      operationNamespace: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4',
      request: authorization,
    }).toString(),
  ).toContain('<nfeDadosMsg><enviNFe')
})

it('extracts only the correlated SP homologation protocol', () => {
  const payload =
    `<retEnviNFe xmlns="${namespace}" versao="4.00"><tpAmb>2</tpAmb>` +
    '<cUF>35</cUF><cStat>104</cStat><xMotivo>Lote processado</xMotivo>' +
    `<protNFe versao="4.00"><infProt><chNFe>${key}</chNFe><nProt>123456789012345</nProt>` +
    '<cStat>100</cStat><xMotivo>Autorizado</xMotivo></infProt></protNFe></retEnviNFe>'
  const result = parseSefazSoapResponse({
    service: 'authorization',
    soap: soap(payload),
    expectedAccessKey: key,
  })
  expect(result).toMatchObject({
    statusCode: '104',
    documentStatusCode: '100',
    accessKey: key,
    protocolNumber: '123456789012345',
  })
  expect(result.protocol?.toString()).toContain('<protNFe')
  expect(() =>
    parseSefazSoapResponse({
      service: 'authorization',
      soap: soap(payload),
      expectedAccessKey: '0'.repeat(44),
    }),
  ).toThrow('access key differs')
})

it('retains receipts and rejects wrong environments or hostile XML', () => {
  const receipt = soap(
    `<retEnviNFe xmlns="${namespace}"><tpAmb>2</tpAmb><cUF>35</cUF>` +
      '<cStat>103</cStat><xMotivo>Lote recebido</xMotivo>' +
      '<nRec>123456789012345</nRec></retEnviNFe>',
  )
  expect(parseSefazSoapResponse({ service: 'authorization', soap: receipt }).receipt).toBe(
    '123456789012345',
  )
  expect(() =>
    parseSefazSoapResponse({
      service: 'authorization',
      soap: Buffer.from(receipt.toString().replace('<tpAmb>2', '<tpAmb>1')),
    }),
  ).toThrow()
  expect(() =>
    parseSefazSoapResponse({
      service: 'authorization',
      soap: Buffer.from(`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${receipt}`),
    }),
  ).toThrow('forbidden declarations')
})
