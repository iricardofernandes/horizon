import { expect, it } from 'vitest'
import { buildNfe55AccessKey } from './access-key'
import {
  parseSefazSoapResponse,
  SefazSoapFault,
  serializeSefazRequest,
  wrapSefazSoap12,
} from './sefaz-soap'

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
  expect(result.response.equals(soap(payload))).toBe(true)
  expect(() =>
    parseSefazSoapResponse({
      service: 'authorization',
      soap: soap(payload),
      expectedAccessKey: '0'.repeat(44),
    }),
  ).toThrow('access key differs')
})

it('reports a SOAP fault without turning it into a fiscal outcome', () => {
  const response = Buffer.from(
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>' +
      '<s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code>' +
      '<s:Reason><s:Text xml:lang="pt-BR">Rejeitado pelo serviço</s:Text></s:Reason>' +
      '</s:Fault></s:Body></s:Envelope>',
  )
  expect(() => parseSefazSoapResponse({ service: 'authorization', soap: response })).toThrow(
    SefazSoapFault,
  )
})

it('correlates a cancellation event to its key, environment and event type', () => {
  const payload =
    `<retEnvEvento xmlns="${namespace}" versao="1.00"><tpAmb>2</tpAmb><cOrgao>35</cOrgao>` +
    '<cStat>128</cStat><xMotivo>Lote processado</xMotivo><retEvento versao="1.00"><infEvento>' +
    `<tpAmb>2</tpAmb><cOrgao>35</cOrgao><chNFe>${key}</chNFe>` +
    '<tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento>' +
    '<cStat>135</cStat><xMotivo>Evento registrado</xMotivo>' +
    '<nProt>123456789012345</nProt></infEvento></retEvento></retEnvEvento>'
  expect(
    parseSefazSoapResponse({ service: 'event', soap: soap(payload), expectedAccessKey: key }),
  ).toMatchObject({ statusCode: '128', eventStatusCode: '135', accessKey: key })
  expect(() =>
    parseSefazSoapResponse({
      service: 'event',
      soap: soap(payload.replace('<tpEvento>110111', '<tpEvento>110110')),
      expectedAccessKey: key,
    }),
  ).toThrow('does not match')
  expect(() =>
    parseSefazSoapResponse({
      service: 'event',
      soap: soap(payload),
      expectedAccessKey: '0'.repeat(44),
    }),
  ).toThrow('access key differs')
})

it('retains receipts and rejects wrong environments or hostile XML', () => {
  const receipt = soap(
    `<retEnviNFe xmlns="${namespace}" versao="4.00"><tpAmb>2</tpAmb><cUF>35</cUF>` +
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

it('rejects duplicate status fields, mismatched versions and extra SOAP payloads', () => {
  const payload =
    `<retEnviNFe xmlns="${namespace}" versao="4.00"><tpAmb>2</tpAmb><cUF>35</cUF>` +
    '<cStat>103</cStat><xMotivo>Lote recebido</xMotivo>' +
    '<nRec>123456789012345</nRec></retEnviNFe>'
  expect(() =>
    parseSefazSoapResponse({
      service: 'authorization',
      soap: soap(payload.replace('<cStat>103</cStat>', '<cStat>103</cStat><cStat>100</cStat>')),
    }),
  ).toThrow('duplicate cStat')
  expect(() =>
    parseSefazSoapResponse({
      service: 'authorization',
      soap: soap(payload.replace('versao="4.00"', 'versao="3.10"')),
    }),
  ).toThrow('version')
  expect(() =>
    parseSefazSoapResponse({ service: 'authorization', soap: soap(payload + payload) }),
  ).toThrow('unique NF-e payload')
  expect(() =>
    parseSefazSoapResponse({
      service: 'authorization',
      soap: Buffer.from(
        soap(payload).toString().replace('</soap12:Body>', '<unexpected/></soap12:Body>'),
      ),
    }),
  ).toThrow('unique response')
})
