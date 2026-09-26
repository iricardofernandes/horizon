import {
  DOMParser,
  XMLSerializer,
  type Document as XmlDocument,
  type Element as XmlElement,
} from '@xmldom/xmldom'
import { z } from 'zod'
import { isValidNfeAccessKey } from './access-key'

const nfeNamespace = 'http://www.portalfiscal.inf.br/nfe'
const soapNamespace = 'http://www.w3.org/2003/05/soap-envelope'
const xmlDeclaration = /^\s*<\?xml\s+[^?]*\?>\s*/i
const accessKeySchema = z.string().regex(/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/)
const receiptSchema = z.string().regex(/^\d{15}$/)
const lotSchema = z.string().regex(/^\d{1,15}$/)
const ufCodeSchema = z.string().regex(/^[1-5][0-9]$/)

export type SefazResponse = {
  service: 'authorization' | 'receipt' | 'protocol' | 'status' | 'event'
  statusCode: string
  reason: string
  receipt: string | null
  accessKey: string | null
  protocolNumber: string | null
  documentStatusCode: string | null
  eventStatusCode: string | null
  response: Buffer
  payload: Buffer
  protocol: Buffer | null
}

export class SefazSoapFault extends Error {
  constructor(readonly code: string) {
    super(`SEFAZ SOAP fault: ${code}`)
    this.name = 'SefazSoapFault'
  }
}

function xmlText(input: Buffer): string {
  if (input.length === 0 || input.length > 2_000_000)
    throw new Error('SEFAZ XML size is outside the supported bound')
  const text = input.toString('utf8')
  if (text.includes('\uFFFD') || /<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error('SEFAZ XML contains forbidden declarations or invalid UTF-8')
  return text
}

function parseXml(input: Buffer): XmlDocument & { documentElement: XmlElement } {
  const errors: string[] = []
  const document = new DOMParser({
    onError: (_level, message) => {
      errors.push(message)
    },
  }).parseFromString(xmlText(input), 'application/xml')
  if (errors.length > 0 || !document.documentElement) throw new Error('SEFAZ XML is malformed')
  return document as XmlDocument & { documentElement: XmlElement }
}

function namedChild(parent: XmlElement, name: string, namespace: string): XmlElement | null {
  let match: XmlElement | null = null
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    const element = node as XmlElement
    if (
      element.nodeType === 1 &&
      element.localName === name &&
      element.namespaceURI === namespace
    ) {
      if (match) throw new Error(`SEFAZ response contains duplicate ${name}`)
      match = element
    }
  }
  return match
}

function elementChildren(parent: XmlElement): XmlElement[] {
  const elements: XmlElement[] = []
  for (let node = parent.firstChild; node; node = node.nextSibling)
    if (node.nodeType === 1) elements.push(node as XmlElement)
  return elements
}

function child(parent: XmlElement, name: string): XmlElement | null {
  return namedChild(parent, name, nfeNamespace)
}

function value(parent: XmlElement, name: string): string | null {
  const element = child(parent, name)
  return element?.textContent?.trim() || null
}

function required(parent: XmlElement, name: string): string {
  const result = value(parent, name)
  if (!result) throw new Error(`SEFAZ response is missing ${name}`)
  return result
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function serializeSefazRequest(
  input:
    | { service: 'authorization'; lotId: string; signedXml: Buffer }
    | { service: 'receipt'; receipt: string }
    | { service: 'protocol'; accessKey: string }
    | { service: 'status'; ufCode: string }
    | { service: 'event'; signedEvent: Buffer },
): Buffer {
  if (input.service === 'authorization') {
    const lotId = lotSchema.parse(input.lotId)
    const document = parseXml(input.signedXml).documentElement
    if (document.localName !== 'NFe' || document.namespaceURI !== nfeNamespace)
      throw new Error('Authorization request requires a signed NF-e')
    return Buffer.from(
      `<enviNFe xmlns="${nfeNamespace}" versao="4.00"><idLote>${lotId}</idLote>` +
        `<indSinc>0</indSinc>${xmlText(input.signedXml).replace(xmlDeclaration, '')}</enviNFe>`,
    )
  }
  if (input.service === 'receipt')
    return Buffer.from(
      `<consReciNFe xmlns="${nfeNamespace}" versao="4.00"><tpAmb>2</tpAmb>` +
        `<nRec>${receiptSchema.parse(input.receipt)}</nRec></consReciNFe>`,
    )
  if (input.service === 'protocol') {
    const key = accessKeySchema.parse(input.accessKey)
    if (!isValidNfeAccessKey(key)) throw new Error('Invalid NF-e access key')
    return Buffer.from(
      `<consSitNFe xmlns="${nfeNamespace}" versao="4.00"><tpAmb>2</tpAmb>` +
        `<xServ>CONSULTAR</xServ><chNFe>${key}</chNFe></consSitNFe>`,
    )
  }
  if (input.service === 'status')
    return Buffer.from(
      `<consStatServ xmlns="${nfeNamespace}" versao="4.00"><tpAmb>2</tpAmb>` +
        `<cUF>${ufCodeSchema.parse(input.ufCode)}</cUF><xServ>STATUS</xServ></consStatServ>`,
    )
  const event = parseXml(input.signedEvent).documentElement
  if (event.localName !== 'envEvento' || event.namespaceURI !== nfeNamespace)
    throw new Error('Cancellation request requires a signed event')
  return Buffer.from(xmlText(input.signedEvent).replace(xmlDeclaration, ''))
}

/** SOAP operation names and namespaces must come from the reviewed WSDL. */
export function wrapSefazSoap12(input: {
  operation: string
  operationNamespace: string
  request: Buffer
}): Buffer {
  const operation = z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/)
    .parse(input.operation)
  const namespace = z.url().parse(input.operationNamespace)
  if (!namespace.startsWith('http://www.portalfiscal.inf.br/nfe/wsdl/'))
    throw new Error('Unapproved NF-e SOAP operation namespace')
  const payload = xmlText(input.request).replace(xmlDeclaration, '')
  parseXml(Buffer.from(payload))
  return Buffer.from(
    `<soap12:Envelope xmlns:soap12="${soapNamespace}"><soap12:Body>` +
      `<${operation} xmlns="${escapeXml(namespace)}"><nfeDadosMsg>${payload}</nfeDadosMsg>` +
      `</${operation}></soap12:Body></soap12:Envelope>`,
  )
}

/** Extracts a single NF-e payload and checks its environment and correlation. */
export function parseSefazSoapResponse(input: {
  service: SefazResponse['service']
  soap: Buffer
  expectedAccessKey?: string
  expectedReceipt?: string
  expectedOperation?: string
  expectedOperationNamespace?: string
  /** IBGE code of the issuer UF; the authorizer answers in that jurisdiction. */
  expectedUfCode: string
}): SefazResponse {
  const ufCode = ufCodeSchema.parse(input.expectedUfCode)
  const document = parseXml(input.soap)
  const envelope = document.documentElement
  if (envelope.localName !== 'Envelope' || envelope.namespaceURI !== soapNamespace)
    throw new Error('SEFAZ response is not SOAP 1.2')
  const body = namedChild(envelope, 'Body', soapNamespace)
  if (!body) throw new Error('SEFAZ SOAP body is missing')
  if (elementChildren(envelope).filter((element) => element.localName === 'Body').length !== 1)
    throw new Error('SEFAZ SOAP envelope has an invalid body')
  const fault = namedChild(body, 'Fault', soapNamespace)
  if (fault) {
    if (elementChildren(body).length !== 1)
      throw new Error('SEFAZ SOAP fault body has extra elements')
    const code = namedChild(fault, 'Code', soapNamespace)
    const faultValue = code ? namedChild(code, 'Value', soapNamespace)?.textContent?.trim() : null
    throw new SefazSoapFault(faultValue || 'unknown')
  }
  const bodyElements = elementChildren(body)
  if (bodyElements.length !== 1) throw new Error('SEFAZ SOAP body has no unique response')
  const wrapper = bodyElements[0]
  if (!wrapper) throw new Error('SEFAZ SOAP response is missing')
  if (input.expectedOperation && input.expectedOperationNamespace) {
    if (
      wrapper.localName !== `${input.expectedOperation}Response` ||
      wrapper.namespaceURI !== input.expectedOperationNamespace
    )
      throw new Error('SEFAZ SOAP response operation does not match the request')
  } else if (
    !wrapper.localName?.endsWith('Response') ||
    !wrapper.namespaceURI?.startsWith('http://www.portalfiscal.inf.br/nfe/wsdl/')
  ) {
    throw new Error('SEFAZ SOAP response wrapper is invalid')
  }
  const result = elementChildren(wrapper)
  if (
    result.length !== 1 ||
    result[0]?.localName !== 'nfeResultMsg' ||
    result[0]?.namespaceURI !== wrapper.namespaceURI
  )
    throw new Error('SEFAZ SOAP result message is invalid')
  const payloads = result[0] ? elementChildren(result[0]) : []
  if (payloads.length !== 1) throw new Error('SEFAZ SOAP body has no unique NF-e payload')
  const payload = payloads[0]
  if (!payload || payload.namespaceURI !== nfeNamespace)
    throw new Error('SEFAZ response payload is missing')
  const expectedRoot: Record<SefazResponse['service'], string> = {
    authorization: 'retEnviNFe',
    receipt: 'retConsReciNFe',
    protocol: 'retConsSitNFe',
    status: 'retConsStatServ',
    event: 'retEnvEvento',
  }
  if (payload.localName !== expectedRoot[input.service])
    throw new Error('SEFAZ response service does not match the request')
  const version = input.service === 'event' ? '1.00' : '4.00'
  if (payload.getAttribute('versao') !== version)
    throw new Error('SEFAZ response version does not match the service')
  if (required(payload, 'tpAmb') !== '2')
    throw new Error('SEFAZ response has the wrong environment')
  if (
    (input.service === 'event' && required(payload, 'cOrgao') !== ufCode) ||
    (input.service !== 'event' && required(payload, 'cUF') !== ufCode)
  )
    throw new Error('SEFAZ response has the wrong jurisdiction')
  const statusCode = required(payload, 'cStat')
  if (!/^\d{3}$/.test(statusCode)) throw new Error('SEFAZ response has an invalid status code')
  const reason = required(payload, 'xMotivo')
  const receiptInfo = child(payload, 'infRec')
  const receipt =
    input.service === 'authorization'
      ? receiptInfo
        ? value(receiptInfo, 'nRec')
        : null
      : value(payload, 'nRec')
  if (receipt && !receiptSchema.safeParse(receipt).success)
    throw new Error('SEFAZ response has an invalid receipt')
  if (statusCode === '103' && input.service === 'authorization' && !receipt)
    throw new Error('SEFAZ received batch response is missing its receipt')
  if (input.expectedReceipt && receipt !== input.expectedReceipt)
    throw new Error('SEFAZ response receipt differs from the request')
  const protocol = child(payload, 'protNFe')
  const protocolInfo = protocol ? child(protocol, 'infProt') : null
  if (protocol && (protocol.getAttribute('versao') !== '4.00' || !protocolInfo))
    throw new Error('SEFAZ response protocol has an invalid version or structure')
  if (protocolInfo && required(protocolInfo, 'tpAmb') !== '2')
    throw new Error('SEFAZ response protocol has the wrong environment')
  const documentStatusCode = protocolInfo ? value(protocolInfo, 'cStat') : null
  if (documentStatusCode && !/^\d{3}$/.test(documentStatusCode))
    throw new Error('SEFAZ response protocol has an invalid status code')
  const event = child(payload, 'retEvento')
  const eventInfo = event ? child(event, 'infEvento') : null
  if (event && (event.getAttribute('versao') !== '1.00' || !eventInfo))
    throw new Error('SEFAZ event response has an invalid version or structure')
  if (eventInfo && input.service === 'event') {
    if (
      required(eventInfo, 'tpAmb') !== '2' ||
      required(eventInfo, 'cOrgao') !== ufCode ||
      required(eventInfo, 'tpEvento') !== '110111' ||
      required(eventInfo, 'nSeqEvento') !== '1'
    )
      throw new Error('SEFAZ cancellation event does not match the supported tuple')
  }
  const eventStatusCode = eventInfo ? value(eventInfo, 'cStat') : null
  if (eventStatusCode && !/^\d{3}$/.test(eventStatusCode))
    throw new Error('SEFAZ event response has an invalid status code')
  const rootAccessKey = value(payload, 'chNFe')
  const nestedAccessKey = protocolInfo
    ? required(protocolInfo, 'chNFe')
    : eventInfo
      ? required(eventInfo, 'chNFe')
      : null
  if (rootAccessKey && nestedAccessKey && rootAccessKey !== nestedAccessKey)
    throw new Error('SEFAZ response access key differs from its protocol')
  const accessKey = nestedAccessKey ?? rootAccessKey
  if (accessKey && !accessKeySchema.safeParse(accessKey).success)
    throw new Error('SEFAZ response has an invalid access key')
  if (accessKey && !isValidNfeAccessKey(accessKey))
    throw new Error('SEFAZ response has an invalid access key check digit')
  if (input.expectedAccessKey && accessKey && accessKey !== input.expectedAccessKey)
    throw new Error('SEFAZ response access key differs from the request')
  if (input.service === 'protocol' && accessKey !== input.expectedAccessKey)
    throw new Error('SEFAZ protocol consultation access key is missing or differs')
  const protocolNumber = protocolInfo
    ? value(protocolInfo, 'nProt')
    : eventInfo
      ? value(eventInfo, 'nProt')
      : null
  if (protocolNumber && !receiptSchema.safeParse(protocolNumber).success)
    throw new Error('SEFAZ response has an invalid protocol number')
  return {
    service: input.service,
    statusCode,
    reason,
    receipt,
    accessKey,
    protocolNumber,
    documentStatusCode,
    eventStatusCode,
    response: Buffer.from(input.soap),
    payload: Buffer.from(new XMLSerializer().serializeToString(payload)),
    protocol: protocol
      ? Buffer.from(new XMLSerializer().serializeToString(protocol))
      : event
        ? Buffer.from(new XMLSerializer().serializeToString(event))
        : null,
  }
}
