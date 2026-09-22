import { createHash } from 'node:crypto'
import { DOMParser } from '@xmldom/xmldom'
import { unzipSync } from 'fflate'
import { SignedXml } from 'xml-crypto'
import { validateXML } from 'xmllint-wasm'
import { z } from 'zod'
import { isValidNfeAccessKey } from './access-key'
import type { SimulationCredential } from './signature'

const namespace = 'http://www.portalfiscal.inf.br/nfe'
const canonicalization = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const enveloped = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
const root = 'PL_010d_v1.03/Evento/'
const main = `${root}envEvento_v1.00.xsd`
const required = [
  main,
  `${root}leiauteEvento_v1.00.xsd`,
  `${root}tiposBasico_v1.03.xsd`,
  `${root}xmldsig-core-schema_v1.01.xsd`,
] as const

const eventSchema = z.strictObject({
  accessKey: z.string().regex(/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/),
  authorizationProtocol: z.string().regex(/^[0-9]{15}([0-9]{2})?$/),
  reason: z.string().trim().min(15).max(255),
  occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/),
  lotId: z.string().regex(/^[0-9]{1,15}$/),
})

/** The event detail is checked here because PL 010d's generic xs:any skips its children. */
export function serializeCancellationEvent(input: z.input<typeof eventSchema>): Buffer {
  const value = eventSchema.parse(input)
  if (!Number.isFinite(Date.parse(value.occurredAt)))
    throw new Error('Invalid cancellation instant')
  if (value.accessKey.slice(0, 2) !== '35') throw new Error('Unsupported cancellation jurisdiction')
  if (!isValidNfeAccessKey(value.accessKey)) throw new Error('Invalid cancellation access key')
  const issuerTaxId = value.accessKey.slice(6, 20)
  const eventId = `ID110111${value.accessKey}01`
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><envEvento xmlns="${namespace}" versao="1.00">` +
      `<idLote>${value.lotId}</idLote><evento versao="1.00"><infEvento Id="${eventId}">` +
      `<cOrgao>35</cOrgao><tpAmb>2</tpAmb><CNPJ>${issuerTaxId}</CNPJ>` +
      `<chNFe>${value.accessKey}</chNFe><dhEvento>${value.occurredAt}</dhEvento>` +
      '<tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>' +
      `<detEvento versao="1.00"><descEvento>Cancelamento</descEvento>` +
      `<nProt>${value.authorizationProtocol}</nProt><xJust>${escapeXml(value.reason)}</xJust>` +
      '</detEvento></infEvento></evento></envEvento>',
    'utf8',
  )
}

export function signCancellationEvent(xml: Buffer, credential: SimulationCredential): Buffer {
  if (!credential.privateKey.length || !credential.certificate.length)
    throw new Error('Simulation signing credential is incomplete')
  const signer = new SignedXml({
    privateKey: credential.privateKey,
    publicCert: credential.certificate,
    canonicalizationAlgorithm: canonicalization,
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  })
  signer.addReference({
    xpath: "//*[local-name(.)='infEvento']",
    transforms: [enveloped, canonicalization],
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
  })
  signer.computeSignature(xml.toString('utf8'), {
    location: { reference: "//*[local-name(.)='infEvento']", action: 'after' },
  })
  return Buffer.from(signer.getSignedXml(), 'utf8')
}

export function verifyCancellationEventSignature(xml: Buffer, certificate: Buffer): void {
  const document = new DOMParser().parseFromString(xml.toString('utf8'), 'application/xml')
  const signatures = document.getElementsByTagNameNS(
    'http://www.w3.org/2000/09/xmldsig#',
    'Signature',
  )
  if (signatures.length !== 1) throw new Error('Cancellation event must have one signature')
  const verifier = new SignedXml({ publicCert: certificate, getCertFromKeyInfo: () => null })
  const signature = signatures.item(0)
  if (!signature) throw new Error('Cancellation event signature is missing')
  verifier.loadSignature(signature as unknown as Node)
  if (!verifier.checkSignature(xml.toString('utf8')))
    throw new Error('Cancellation event signature is invalid')
  const references = verifier.getSignedReferences()
  if (references.length !== 1 || !references[0]?.includes('<infEvento'))
    throw new Error('Cancellation signature did not authenticate infEvento')
}

export async function validateCancellationEventSchema(input: {
  xml: Buffer
  schemaZip: Buffer
  expectedZipDigest: string
}): Promise<void> {
  if (createHash('sha256').update(input.schemaZip).digest('hex') !== input.expectedZipDigest)
    throw new Error('Cancellation schema package digest mismatch')
  const archive = unzipSync(input.schemaZip)
  const entries = required.map((path) => {
    const contents = archive[path]
    if (!contents) throw new Error(`Cancellation schema package is missing ${path}`)
    return { fileName: path, contents }
  })
  const schema = entries.find((entry) => entry.fileName === main)
  if (!schema) throw new Error('Cancellation main schema is missing')
  const result = await validateXML({
    xml: { fileName: 'cancellation.xml', contents: input.xml },
    schema,
    preload: entries.filter((entry) => entry.fileName !== main),
  })
  if (!result.valid)
    throw new Error(
      `Cancellation XML schema validation failed: ${result.errors
        .slice(0, 3)
        .map((error) => error.message)
        .join('; ')}`,
    )
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
