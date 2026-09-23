import { expect, it } from 'vitest'
import { buildNfe55AccessKey } from './access-key'
import { SefazNfe55HomologationAdapter, type SefazOperationMap } from './sefaz-adapter'

const namespace = 'http://www.portalfiscal.inf.br/nfe'
const operationNamespace = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4'
const operations: SefazOperationMap = {
  wsdlDigest: 'a'.repeat(64),
  authorization: { operation: 'nfeAutorizacaoLote', operationNamespace },
  receipt: { operation: 'nfeRetAutorizacaoLote', operationNamespace },
  protocol: { operation: 'nfeConsultaNF', operationNamespace },
  status: { operation: 'nfeStatusServicoNF', operationNamespace },
  event: { operation: 'nfeRecepcaoEvento', operationNamespace },
}
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

it('prepares a status request and parses the exact response bytes', async () => {
  const response = Buffer.from(
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>` +
      `<nfeStatusServicoNFResponse xmlns="${operationNamespace}"><nfeResultMsg>` +
      `<retConsStatServ xmlns="${namespace}" versao="4.00"><tpAmb>2</tpAmb><cUF>35</cUF>` +
      '<cStat>107</cStat><xMotivo>Servico em operacao</xMotivo></retConsStatServ>' +
      '</nfeResultMsg></nfeStatusServicoNFResponse></s:Body></s:Envelope>',
  )
  const adapter = new SefazNfe55HomologationAdapter(
    { certificate: Buffer.alloc(0), issuerTaxId: '00000000E08G12' },
    operations,
  )
  const prepared = await adapter.prepare({ service: 'status' })
  expect(prepared.request.toString()).toContain('<cUF>35</cUF><xServ>STATUS</xServ>')
  const parsed = adapter.parseResponse(prepared, response)
  expect(parsed).toMatchObject({
    statusCode: '107',
    service: 'status',
  })
  expect(parsed.response).toEqual(response)
})

it('rejects a response bound to a different prepared service', async () => {
  const adapter = new SefazNfe55HomologationAdapter(
    { certificate: Buffer.alloc(0), issuerTaxId: '00000000E08G12' },
    operations,
  )
  const prepared = await adapter.prepare({ service: 'status' })
  const wrong = Buffer.from(
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>` +
      `<retConsSitNFe xmlns="${namespace}" versao="4.00"><tpAmb>2</tpAmb>` +
      '<cStat>100</cStat><xMotivo>Autorizado</xMotivo></retConsSitNFe>' +
      '</s:Body></s:Envelope>',
  )
  expect(() => adapter.parseResponse(prepared, wrong)).toThrow()
  const wrongOperation = Buffer.from(
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>` +
      `<nfeAutorizacaoLoteResponse xmlns="${operationNamespace}"><nfeResultMsg>` +
      `<retConsStatServ xmlns="${namespace}" versao="4.00"><tpAmb>2</tpAmb><cUF>35</cUF>` +
      '<cStat>107</cStat><xMotivo>Servico em operacao</xMotivo></retConsStatServ>' +
      '</nfeResultMsg></nfeAutorizacaoLoteResponse></s:Body></s:Envelope>',
  )
  expect(() => adapter.parseResponse(prepared, wrongOperation)).toThrow('operation does not match')
})

it('refuses an unsigned authorization before preparing an envelope', async () => {
  const adapter = new SefazNfe55HomologationAdapter(
    { certificate: Buffer.alloc(0), issuerTaxId: '00000000E08G12' },
    operations,
  )
  await expect(
    adapter.prepare({
      service: 'authorization',
      lotId: '1',
      accessKey: key,
      signedXml: Buffer.from(`<NFe xmlns="${namespace}"><infNFe Id="NFe${key}"/></NFe>`),
      schemaZip: Buffer.alloc(0),
      schemaDigest: 'b'.repeat(64),
    }),
  ).rejects.toThrow('signature')
})

it('refuses a request for an issuer other than the certificate holder', async () => {
  const adapter = new SefazNfe55HomologationAdapter(
    { certificate: Buffer.alloc(0), issuerTaxId: '12345678000195' },
    operations,
  )
  await expect(adapter.prepare({ service: 'protocol', accessKey: key })).rejects.toThrow(
    'issuer differs from the certificate',
  )
})
