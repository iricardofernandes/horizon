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

it('exchanges a status request and retains the exact request and response bytes', async () => {
  const response = Buffer.from(
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>` +
      `<nfeStatusServicoNFResponse xmlns="${operationNamespace}"><nfeResultMsg>` +
      `<retConsStatServ xmlns="${namespace}" versao="4.00"><tpAmb>2</tpAmb><cUF>35</cUF>` +
      '<cStat>107</cStat><xMotivo>Servico em operacao</xMotivo></retConsStatServ>' +
      '</nfeResultMsg></nfeStatusServicoNFResponse></s:Body></s:Envelope>',
  )
  let sent: Buffer | null = null
  let calls = 0
  const adapter = new SefazNfe55HomologationAdapter(
    {
      async send(service, request) {
        calls += 1
        expect(service).toBe('status')
        sent = request
        return response
      },
    },
    { certificate: Buffer.alloc(0) },
    operations,
  )
  const prepared = await adapter.prepare({ service: 'status' })
  expect(calls).toBe(0)
  expect(prepared.request.toString()).toContain('<cUF>35</cUF><xServ>STATUS</xServ>')
  expect(adapter.parseResponse(prepared, response)).toMatchObject({
    statusCode: '107',
    service: 'status',
  })
  const exchange = await adapter.exchange({ service: 'status' })
  expect(calls).toBe(1)
  expect(exchange.request).toEqual(prepared.request)
  expect(exchange.request).toEqual(sent)
  expect(exchange.request.toString()).toContain('<cUF>35</cUF><xServ>STATUS</xServ>')
  expect(exchange.response).toMatchObject({ statusCode: '107', service: 'status' })
  expect(exchange.response.response).toEqual(response)
})

it('rejects a response bound to a different prepared service', async () => {
  const adapter = new SefazNfe55HomologationAdapter(
    {
      async send() {
        throw new Error('unexpected transport call')
      },
    },
    { certificate: Buffer.alloc(0) },
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
})

it('refuses an unsigned authorization before sending to the authority', async () => {
  let calls = 0
  const adapter = new SefazNfe55HomologationAdapter(
    {
      async send() {
        calls += 1
        return Buffer.alloc(0)
      },
    },
    { certificate: Buffer.alloc(0) },
    operations,
  )
  await expect(
    adapter.exchange({
      service: 'authorization',
      lotId: '1',
      accessKey: key,
      signedXml: Buffer.from(`<NFe xmlns="${namespace}"><infNFe Id="NFe${key}"/></NFe>`),
      schemaZip: Buffer.alloc(0),
      schemaDigest: 'b'.repeat(64),
    }),
  ).rejects.toThrow('signature')
  expect(calls).toBe(0)
})
