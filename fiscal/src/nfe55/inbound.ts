import { createHash, X509Certificate } from 'node:crypto'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { SignedXml } from 'xml-crypto'
import { isValidNfeAccessKey } from './access-key'
import { certificateLegalEntityCnpj } from './icp-brasil-cnpj'
import { validateNfe55Schema } from './schema'

const NFE = 'http://www.portalfiscal.inf.br/nfe'
const DSIG = 'http://www.w3.org/2000/09/xmldsig#'
export const INBOUND_XML_LIMIT = 1024 * 1024

export type InboundRejectionCode =
  | 'XML_TOO_LARGE'
  | 'XML_FORBIDDEN_DECLARATION'
  | 'XML_MALFORMED'
  | 'SCHEMA_INVALID'
  | 'UNSUPPORTED_DOCUMENT'
  | 'ACCESS_KEY_INVALID'
  | 'RECIPIENT_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'SIGNER_MISMATCH'
  | 'PROTOCOL_INVALID'

/** A refusal with a stable code; the message never echoes document content. */
export class InboundRejection extends Error {
  constructor(
    readonly code: InboundRejectionCode,
    message: string,
  ) {
    super(message)
    this.name = 'InboundRejection'
  }
}

export type InboundTax = {
  group: string
  cst: string | null
  base: string | null
  rate: string | null
  value: string | null
}

export type InboundLine = {
  number: number
  productCode: string
  gtin: string | null
  description: string
  ncm: string
  cfop: string
  unit: string
  quantity: string
  unitPrice: string
  gross: string
  discount: string
  orderReference: string | null
  orderLineReference: string | null
  taxes: InboundTax[]
}

export type InboundInvoice = {
  accessKey: string
  series: number
  number: number
  issuedAt: string
  natureOperation: string
  environment: 'production' | 'homologation'
  issuer: {
    taxId: string
    kind: 'cnpj' | 'cpf'
    legalName: string
    tradeName: string | null
    stateRegistration: string | null
    uf: string
    municipalityCode: string
  }
  recipient: { taxId: string; legalName: string | null }
  lines: InboundLine[]
  totals: {
    products: string
    discounts: string
    freight: string
    insurance: string
    other: string
    icms: string
    icmsSt: string
    ipi: string
    pis: string
    cofins: string
    invoice: string
    ibs: string | null
    cbs: string | null
    invoiceWithIbsCbs: string | null
  }
}

export type InboundVerification = {
  sourceDigest: string
  contentDigest: string
  signature: 'valid-unanchored'
  signerTaxId: string
  protocol:
    | { status: 'absent' }
    | {
        status: 'authorized'
        code: '100' | '150'
        number: string
        receivedAt: string
      }
  authorityStatus: 'unverified'
}

export type VerifiedInboundNfe = { invoice: InboundInvoice; verification: InboundVerification }

type XmlDocument = ReturnType<DOMParser['parseFromString']>
type XmlElement = NonNullable<XmlDocument['documentElement']>

/**
 * Verifies one supplier NF-e model 55 (bare `NFe` or `nfeProc`) addressed to the tenant.
 * Every business field is read from the canonical `infNFe` the signature authenticated,
 * so content outside the signed element can never change what is staged.
 */
export async function verifyInboundNfe55(input: {
  xml: Buffer
  recipientTaxId: string
  schemaZip: Buffer
  expectedZipDigest: string
}): Promise<VerifiedInboundNfe> {
  const text = boundedText(input.xml)
  const document = parse(text)
  const root = document.documentElement as XmlElement
  if (root.namespaceURI !== NFE || !['NFe', 'nfeProc'].includes(root.localName ?? ''))
    throw new InboundRejection('UNSUPPORTED_DOCUMENT', 'Root must be NFe or nfeProc')
  const nfe = root.localName === 'NFe' ? root : exactlyOne(root, 'NFe', NFE, 'NFe')
  if (
    root.localName === 'nfeProc' &&
    (root.getAttribute('versao') !== '4.00' ||
      elementChildren(root)
        .map((element) => `${element.namespaceURI}|${element.localName}`)
        .join() !== `${NFE}|NFe,${NFE}|protNFe`)
  )
    throw new InboundRejection('UNSUPPORTED_DOCUMENT', 'nfeProc must hold one NFe and its protocol')

  try {
    await validateNfe55Schema({
      xml: Buffer.from(new XMLSerializer().serializeToString(nfe), 'utf8'),
      schemaZip: input.schemaZip,
      expectedZipDigest: input.expectedZipDigest,
      family: 'inbound',
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('digest mismatch')) throw error
    throw new InboundRejection('SCHEMA_INVALID', 'NF-e does not match the PL 010f schema')
  }

  const signedNfe = exactlyOne(nfe, 'infNFe', NFE, 'infNFe')
  const accessKey = (signedNfe.getAttribute('Id') ?? '').replace(/^NFe/, '')
  if (!isValidNfeAccessKey(accessKey) || signedNfe.getAttribute('Id') !== `NFe${accessKey}`)
    throw new InboundRejection('ACCESS_KEY_INVALID', 'infNFe Id is not a valid access key')

  const { canonical, digestValue, signerTaxId } = verifySignature(text, nfe, accessKey)
  const invoice = readInvoice(parse(canonical).documentElement as XmlElement, accessKey)
  if (normalizedTaxId(input.recipientTaxId) !== invoice.recipient.taxId)
    throw new InboundRejection('RECIPIENT_MISMATCH', 'NF-e is addressed to another company')
  if (
    invoice.issuer.kind === 'cnpj' &&
    signerTaxId.slice(0, 8) !== invoice.issuer.taxId.slice(0, 8)
  )
    throw new InboundRejection('SIGNER_MISMATCH', 'Signing certificate belongs to another CNPJ')

  const protocol =
    root.localName === 'nfeProc'
      ? readProtocol(root, accessKey, digestValue, invoice.environment)
      : ({ status: 'absent' } as const)
  return {
    invoice,
    verification: {
      sourceDigest: sha256(input.xml),
      contentDigest: sha256(Buffer.from(canonical, 'utf8')),
      signature: 'valid-unanchored',
      signerTaxId,
      protocol,
      authorityStatus: 'unverified',
    },
  }
}

function boundedText(xml: Buffer): string {
  if (xml.length === 0 || xml.length > INBOUND_XML_LIMIT)
    throw new InboundRejection('XML_TOO_LARGE', 'NF-e XML must have 1 byte to 1 MiB')
  const text = xml.toString('utf8')
  if (text.includes('�'))
    throw new InboundRejection('XML_FORBIDDEN_DECLARATION', 'NF-e XML is not valid UTF-8')
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || /<\?(?!xml\s)/i.test(text.replace(/^﻿/, '')))
    throw new InboundRejection(
      'XML_FORBIDDEN_DECLARATION',
      'NF-e XML contains a forbidden declaration',
    )
  return text
}

function parse(text: string): XmlDocument {
  const errors: string[] = []
  let document: XmlDocument
  try {
    document = new DOMParser({
      onError: (_level, message) => {
        errors.push(message)
      },
    }).parseFromString(text, 'application/xml')
  } catch {
    throw new InboundRejection('XML_MALFORMED', 'NF-e XML is malformed')
  }
  if (errors.length > 0 || !document.documentElement)
    throw new InboundRejection('XML_MALFORMED', 'NF-e XML is malformed')
  return document
}

function verifySignature(
  text: string,
  nfe: XmlElement,
  accessKey: string,
): { canonical: string; digestValue: string; signerTaxId: string } {
  const signature = exactlyOne(nfe, 'Signature', DSIG, 'Signature', 'SIGNATURE_INVALID')
  const keyInfo = exactlyOne(signature, 'KeyInfo', DSIG, 'KeyInfo', 'SIGNATURE_INVALID')
  const data = exactlyOne(keyInfo, 'X509Data', DSIG, 'X509Data', 'SIGNATURE_INVALID')
  const encoded = exactlyOne(data, 'X509Certificate', DSIG, 'X509Certificate', 'SIGNATURE_INVALID')
  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(
      Buffer.from((encoded.textContent ?? '').replace(/\s+/g, ''), 'base64'),
    )
  } catch {
    throw new InboundRejection('SIGNATURE_INVALID', 'Signing certificate cannot be read')
  }
  const verifier = new SignedXml({
    publicCert: certificate.toString(),
    getCertFromKeyInfo: () => null,
  })
  let valid = false
  try {
    verifier.loadSignature(signature as unknown as Node)
    valid = verifier.checkSignature(text)
  } catch {
    valid = false
  }
  const references = verifier.getReferences()
  const signed = verifier.getSignedReferences()
  if (
    !valid ||
    references.length !== 1 ||
    references[0]?.uri !== `#NFe${accessKey}` ||
    signed.length !== 1 ||
    !signed[0]?.startsWith('<infNFe')
  )
    throw new InboundRejection('SIGNATURE_INVALID', 'NF-e XML signature is invalid')
  let signerTaxId: string
  try {
    signerTaxId = certificateLegalEntityCnpj(certificate)
  } catch {
    throw new InboundRejection('SIGNER_MISMATCH', 'Signing certificate has no ICP-Brasil CNPJ')
  }
  const issuedAt = Date.parse(
    exactlyOne(
      exactlyOne(parse(signed[0]).documentElement as XmlElement, 'ide', NFE, 'ide'),
      'dhEmi',
      NFE,
      'dhEmi',
    ).textContent ?? '',
  )
  if (
    !Number.isFinite(issuedAt) ||
    issuedAt < Date.parse(certificate.validFrom) ||
    issuedAt > Date.parse(certificate.validTo)
  )
    throw new InboundRejection('SIGNER_MISMATCH', 'Signing certificate was not valid at issue')
  return {
    canonical: signed[0],
    digestValue: String(references[0]?.digestValue ?? ''),
    signerTaxId,
  }
}

function readInvoice(infNFe: XmlElement, accessKey: string): InboundInvoice {
  const ide = exactlyOne(infNFe, 'ide', NFE, 'ide')
  if (infNFe.getAttribute('versao') !== '4.00' || text(ide, 'mod') !== '55')
    throw new InboundRejection(
      'UNSUPPORTED_DOCUMENT',
      'Only NF-e model 55 version 4.00 is accepted',
    )
  if (text(ide, 'tpNF') !== '1' || text(ide, 'finNFe') !== '1')
    throw new InboundRejection(
      'UNSUPPORTED_DOCUMENT',
      'Only a normal outbound supplier NF-e is accepted',
    )
  const issuedAt = text(ide, 'dhEmi')
  const series = Number(text(ide, 'serie'))
  const number = Number(text(ide, 'nNF'))
  const emit = exactlyOne(infNFe, 'emit', NFE, 'emit')
  const issuerCnpj = optionalText(emit, 'CNPJ')
  const issuerCpf = optionalText(emit, 'CPF')
  const issuerTaxId = issuerCnpj ?? issuerCpf
  if (!issuerTaxId) throw new InboundRejection('UNSUPPORTED_DOCUMENT', 'Issuer has no tax id')
  const keyTaxId = issuerCnpj ?? `000${issuerCpf}`
  const expectations: Array<[string, string]> = [
    [accessKey.slice(0, 2), text(ide, 'cUF')],
    [accessKey.slice(2, 6), `${issuedAt.slice(2, 4)}${issuedAt.slice(5, 7)}`],
    [accessKey.slice(6, 20), keyTaxId],
    [accessKey.slice(20, 22), '55'],
    [accessKey.slice(22, 25), text(ide, 'serie').padStart(3, '0')],
    [accessKey.slice(25, 34), text(ide, 'nNF').padStart(9, '0')],
    [accessKey.slice(34, 35), text(ide, 'tpEmis')],
    [accessKey.slice(35, 43), text(ide, 'cNF')],
    [accessKey.slice(43), text(ide, 'cDV')],
  ]
  if (expectations.some(([key, content]) => key !== content))
    throw new InboundRejection('ACCESS_KEY_INVALID', 'Access key does not match the NF-e content')
  const address = exactlyOne(emit, 'enderEmit', NFE, 'enderEmit')
  const dest = optionalChild(infNFe, 'dest')
  const recipientTaxId = dest ? (optionalText(dest, 'CNPJ') ?? optionalText(dest, 'CPF')) : null
  if (!dest || !recipientTaxId)
    throw new InboundRejection('RECIPIENT_MISMATCH', 'NF-e has no identified recipient')
  const totals = exactlyOne(exactlyOne(infNFe, 'total', NFE, 'total'), 'ICMSTot', NFE, 'ICMSTot')
  const total = optionalChild(exactlyOne(infNFe, 'total', NFE, 'total'), 'IBSCBSTot')
  return {
    accessKey,
    series,
    number,
    issuedAt,
    natureOperation: text(ide, 'natOp'),
    environment: text(ide, 'tpAmb') === '1' ? 'production' : 'homologation',
    issuer: {
      taxId: issuerTaxId,
      kind: issuerCnpj ? 'cnpj' : 'cpf',
      legalName: text(emit, 'xNome'),
      tradeName: optionalText(emit, 'xFant'),
      stateRegistration: optionalText(emit, 'IE'),
      uf: text(address, 'UF'),
      municipalityCode: text(address, 'cMun'),
    },
    recipient: { taxId: recipientTaxId, legalName: optionalText(dest, 'xNome') },
    lines: children(infNFe, 'det').map(readLine),
    totals: {
      products: text(totals, 'vProd'),
      discounts: text(totals, 'vDesc'),
      freight: text(totals, 'vFrete'),
      insurance: text(totals, 'vSeg'),
      other: text(totals, 'vOutro'),
      icms: text(totals, 'vICMS'),
      icmsSt: text(totals, 'vST'),
      ipi: text(totals, 'vIPI'),
      pis: text(totals, 'vPIS'),
      cofins: text(totals, 'vCOFINS'),
      invoice: text(totals, 'vNF'),
      ibs: total ? (firstDescendantText(total, 'vIBS') ?? null) : null,
      cbs: total ? (firstDescendantText(total, 'vCBS') ?? null) : null,
      invoiceWithIbsCbs: optionalText(exactlyOne(infNFe, 'total', NFE, 'total'), 'vNFTot'),
    },
  }
}

function readLine(det: XmlElement): InboundLine {
  const product = exactlyOne(det, 'prod', NFE, 'prod')
  const gtin = optionalText(product, 'cEAN')
  const imposto = optionalChild(det, 'imposto')
  return {
    number: Number(det.getAttribute('nItem')),
    productCode: text(product, 'cProd'),
    gtin: gtin && gtin !== 'SEM GTIN' ? gtin : null,
    description: text(product, 'xProd'),
    ncm: text(product, 'NCM'),
    cfop: text(product, 'CFOP'),
    unit: text(product, 'uCom'),
    quantity: text(product, 'qCom'),
    unitPrice: text(product, 'vUnCom'),
    gross: text(product, 'vProd'),
    discount: optionalText(product, 'vDesc') ?? '0.00',
    orderReference: optionalText(product, 'xPed'),
    orderLineReference: optionalText(product, 'nItemPed'),
    taxes: imposto ? readTaxes(imposto) : [],
  }
}

/** One entry per tax group; IBS/CBS is split so each carries its own value. */
function readTaxes(imposto: XmlElement): InboundTax[] {
  return elementChildren(imposto)
    .filter((group) => group.localName !== 'vTotTrib')
    .flatMap((group) => {
      const name = group.localName ?? ''
      const cst = firstDescendantText(group, 'CST') ?? firstDescendantText(group, 'CSOSN')
      if (name === 'IBSCBS')
        return (['IBS', 'CBS'] as const).map((part) => ({
          group: part,
          cst,
          base: firstDescendantText(group, 'vBC'),
          rate: part === 'CBS' ? firstDescendantText(group, 'pCBS') : null,
          value: firstDescendantText(group, `v${part}`),
        }))
      return [
        {
          group: name,
          cst,
          base: firstDescendantText(group, 'vBC'),
          rate: firstDescendantText(group, `p${name}`),
          value: firstDescendantText(group, `v${name}`),
        },
      ]
    })
}

function readProtocol(
  root: XmlElement,
  accessKey: string,
  digestValue: string,
  environment: InboundInvoice['environment'],
): InboundVerification['protocol'] {
  const protocol = exactlyOne(root, 'protNFe', NFE, 'protNFe', 'PROTOCOL_INVALID')
  const info = exactlyOne(protocol, 'infProt', NFE, 'infProt', 'PROTOCOL_INVALID')
  const code = optionalText(info, 'cStat')
  const expectedEnvironment = environment === 'production' ? '1' : '2'
  if (
    optionalText(info, 'chNFe') !== accessKey ||
    (code !== '100' && code !== '150') ||
    optionalText(info, 'digVal') !== digestValue ||
    optionalText(info, 'tpAmb') !== expectedEnvironment
  )
    throw new InboundRejection('PROTOCOL_INVALID', 'Authorization protocol does not match the NF-e')
  const number = optionalText(info, 'nProt')
  const receivedAt = optionalText(info, 'dhRecbto')
  if (!number || !/^\d{15}$/.test(number) || !receivedAt)
    throw new InboundRejection('PROTOCOL_INVALID', 'Authorization protocol is incomplete')
  return { status: 'authorized', code, number, receivedAt }
}

function normalizedTaxId(value: string): string {
  return value.toUpperCase().replace(/[.\-/\s]/g, '')
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function elementChildren(parent: XmlElement): XmlElement[] {
  const elements: XmlElement[] = []
  for (let node = parent.firstChild; node; node = node.nextSibling)
    if (node.nodeType === 1) elements.push(node as XmlElement)
  return elements
}

function children(parent: XmlElement, name: string, namespace = NFE): XmlElement[] {
  return elementChildren(parent).filter(
    (element) => element.localName === name && element.namespaceURI === namespace,
  )
}

function exactlyOne(
  parent: XmlElement,
  name: string,
  namespace: string,
  label: string,
  code: InboundRejectionCode = 'UNSUPPORTED_DOCUMENT',
): XmlElement {
  const matches = children(parent, name, namespace)
  if (matches.length !== 1)
    throw new InboundRejection(code, `NF-e must contain exactly one ${label}`)
  return matches[0] as XmlElement
}

function optionalChild(parent: XmlElement, name: string): XmlElement | null {
  const matches = children(parent, name)
  if (matches.length > 1)
    throw new InboundRejection('UNSUPPORTED_DOCUMENT', `NF-e contains duplicate ${name}`)
  return matches[0] ?? null
}

function text(parent: XmlElement, name: string): string {
  const value = optionalText(parent, name)
  if (value === null) throw new InboundRejection('UNSUPPORTED_DOCUMENT', `NF-e is missing ${name}`)
  return value
}

function optionalText(parent: XmlElement, name: string): string | null {
  const element = optionalChild(parent, name)
  return element ? (element.textContent ?? '').trim() : null
}

function firstDescendantText(parent: XmlElement, name: string): string | null {
  const nodes = parent.getElementsByTagNameNS(NFE, name)
  const first = nodes.item(0)
  return first ? (first.textContent ?? '').trim() : null
}
