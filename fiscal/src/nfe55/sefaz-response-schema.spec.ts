import { readFile } from 'node:fs/promises'
import { beforeAll, expect, it } from 'vitest'
import {
  type SefazResponseSchemaSource,
  SefazResponseSchemaValidator,
  validateSefazResponseSchema,
} from './sefaz-response-schema'
import type { SefazService } from './sefaz-transport'

const namespace = 'http://www.portalfiscal.inf.br/nfe'
const timestamp = '2026-09-23T12:00:00-03:00'
const accessKey = '35260912345678000195550010000000011123456780'
let documentSource: SefazResponseSchemaSource
let consultationSource: SefazResponseSchemaSource

beforeAll(async () => {
  const [document, consultation] = await Promise.all([
    readFile(new URL('../../fixtures/official/pl-009p-v1.03.zip', import.meta.url)),
    readFile(new URL('../../fixtures/official/pl-010d-v1.03.zip', import.meta.url)),
  ])
  documentSource = {
    archive: document,
    digest: '2e925939a228aaf785be9fe7d6315f2da94d3a10036d54ffb7c1273aa7502b05',
  }
  consultationSource = {
    archive: consultation,
    digest: '45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b',
  }
})

const cases: { service: SefazService; xml: string }[] = [
  {
    service: 'authorization',
    xml:
      `<retEnviNFe xmlns="${namespace}" versao="4.00"><tpAmb>2</tpAmb>` +
      `<verAplic>SP-v1</verAplic><cStat>103</cStat><xMotivo>Lote recebido</xMotivo>` +
      `<cUF>35</cUF><dhRecbto>${timestamp}</dhRecbto>` +
      '<infRec><nRec>123456789012345</nRec><tMed>1</tMed></infRec></retEnviNFe>',
  },
  {
    service: 'status',
    xml:
      `<retConsStatServ xmlns="${namespace}" versao="4.00"><tpAmb>2</tpAmb>` +
      '<verAplic>SP-v1</verAplic><cStat>107</cStat><xMotivo>Servico em operacao</xMotivo>' +
      `<cUF>35</cUF><dhRecbto>${timestamp}</dhRecbto></retConsStatServ>`,
  },
  {
    service: 'receipt',
    xml:
      `<retConsReciNFe xmlns="${namespace}" versao="4.00"><tpAmb>2</tpAmb>` +
      '<verAplic>SP-v1</verAplic><nRec>123456789012345</nRec><cStat>105</cStat>' +
      `<xMotivo>Em processamento</xMotivo><cUF>35</cUF><dhRecbto>${timestamp}</dhRecbto>` +
      '</retConsReciNFe>',
  },
  {
    service: 'protocol',
    xml:
      `<retConsSitNFe xmlns="${namespace}" versao="4.00"><tpAmb>2</tpAmb>` +
      '<verAplic>SP-v1</verAplic><cStat>217</cStat><xMotivo>Sem protocolo</xMotivo>' +
      `<cUF>35</cUF><dhRecbto>${timestamp}</dhRecbto><chNFe>${accessKey}</chNFe>` +
      '</retConsSitNFe>',
  },
  {
    service: 'event',
    xml:
      `<retEnvEvento xmlns="${namespace}" versao="1.00"><idLote>1</idLote>` +
      '<tpAmb>2</tpAmb><verAplic>SP-v1</verAplic><cOrgao>35</cOrgao>' +
      '<cStat>128</cStat><xMotivo>Lote processado</xMotivo></retEnvEvento>',
  },
]

for (const { service, xml } of cases) {
  it(`validates a ${service} payload against the pinned official response XSD`, async () => {
    const source =
      service === 'authorization' || service === 'status' ? documentSource : consultationSource
    await expect(
      validateSefazResponseSchema({ service, payload: Buffer.from(xml), source }),
    ).resolves.toBeUndefined()
    await expect(
      validateSefazResponseSchema({
        service,
        payload: Buffer.from(xml.replace('<tpAmb>2</tpAmb>', '<tpAmb>9</tpAmb>')),
        source,
      }),
    ).rejects.toThrow('schema validation failed')
  })
}

it('refuses a substituted official archive', async () => {
  expect(
    () =>
      new SefazResponseSchemaValidator(
        { archive: documentSource.archive, digest: '0'.repeat(64) },
        consultationSource,
      ),
  ).toThrow('digest mismatch')
  await expect(
    validateSefazResponseSchema({
      service: 'status',
      payload: Buffer.from(cases[1]?.xml ?? ''),
      source: { archive: documentSource.archive, digest: '0'.repeat(64) },
    }),
  ).rejects.toThrow('digest mismatch')
})
