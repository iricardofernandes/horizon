import { createHash, X509Certificate } from 'node:crypto'
import { DOMParser, type Element as XmlElement } from '@xmldom/xmldom'
import { z } from 'zod'
import { isValidNfeAccessKey } from './access-key'
import {
  validateCancellationEventSchema,
  verifyCancellationEventSignature,
} from './cancellation-event'
import type { HomologationCredential } from './homologation-credential'
import { validateNfe55Schema } from './schema'
import {
  parseSefazSoapResponse,
  type SefazResponse,
  serializeSefazRequest,
  wrapSefazSoap12,
} from './sefaz-soap'
import type { SefazService } from './sefaz-transport'
import { verifyNfe55Signature } from './signature'

const accessKeySchema = z.string().length(44).refine(isValidNfeAccessKey)
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const protocolSchema = z.string().regex(/^[0-9]{15}$/)
const nfeNamespace = 'http://www.portalfiscal.inf.br/nfe'

export type SefazOperationMap = Record<
  SefazService,
  { operation: string; operationNamespace: string }
> & { wsdlDigest: string }

export type SefazExchangeInput =
  | {
      service: 'authorization'
      lotId: string
      accessKey: string
      signedXml: Buffer
      schemaZip: Buffer
      schemaDigest: string
    }
  | {
      service: 'event'
      accessKey: string
      signedEvent: Buffer
      schemaZip: Buffer
      schemaDigest: string
    }
  | { service: 'receipt'; receipt: string; accessKey: string }
  | { service: 'protocol'; accessKey: string }
  | { service: 'status' }

export type PreparedSefazExchange = {
  service: SefazService
  request: Buffer
  operation: string
  operationNamespace: string
  expectedAccessKey?: string
  expectedReceipt?: string
  expectedAuthorizationProtocol?: string
}

/** Prepares and parses one exchange; the durable runner owns every network send. */
export class SefazNfe55HomologationAdapter {
  readonly wsdlDigest: string
  readonly certificateFingerprint: string | null

  constructor(
    private readonly credential: Pick<HomologationCredential, 'certificate' | 'issuerTaxId'>,
    private readonly operations: SefazOperationMap,
  ) {
    this.wsdlDigest = digestSchema.parse(operations.wsdlDigest)
    this.certificateFingerprint = credential.certificate.length
      ? createHash('sha256').update(new X509Certificate(credential.certificate).raw).digest('hex')
      : null
  }

  async prepare(input: SefazExchangeInput): Promise<PreparedSefazExchange> {
    if (input.service !== 'status') {
      accessKeySchema.parse(input.accessKey)
      if (input.accessKey.slice(0, 2) !== '35')
        throw new Error('SEFAZ adapter requires an SP access key')
      if (input.accessKey.slice(6, 20) !== this.credential.issuerTaxId)
        throw new Error('SEFAZ access key issuer differs from the certificate')
    }
    if (input.service === 'authorization') {
      const signedReference = verifyNfe55Signature(input.signedXml, this.credential.certificate)
      assertSignedField(signedReference, 'infNFe', 'Id', `NFe${input.accessKey}`)
      assertSignedElement(input.signedXml, 'tpAmb', '2')
      await validateNfe55Schema({
        xml: input.signedXml,
        schemaZip: input.schemaZip,
        expectedZipDigest: input.schemaDigest,
      })
    } else if (input.service === 'event') {
      verifyCancellationEventSignature(input.signedEvent, this.credential.certificate)
      assertSignedElement(input.signedEvent, 'chNFe', input.accessKey)
      assertSignedElement(input.signedEvent, 'tpAmb', '2')
      assertSignedElement(input.signedEvent, 'tpEvento', '110111')
      await validateCancellationEventSchema({
        xml: input.signedEvent,
        schemaZip: input.schemaZip,
        expectedZipDigest: input.schemaDigest,
      })
    }
    const requestPayload = serializeSefazRequest(input)
    const operation = this.operations[input.service]
    if (!operation) throw new Error('SEFAZ SOAP operation is not configured')
    const request = wrapSefazSoap12({ ...operation, request: requestPayload })
    return {
      service: input.service,
      request,
      operation: operation.operation,
      operationNamespace: operation.operationNamespace,
      ...('accessKey' in input ? { expectedAccessKey: input.accessKey } : {}),
      ...(input.service === 'receipt' ? { expectedReceipt: input.receipt } : {}),
      ...(input.service === 'event'
        ? {
            expectedAuthorizationProtocol: protocolSchema.parse(
              onlyElement(input.signedEvent, 'nProt').textContent?.trim(),
            ),
          }
        : {}),
    }
  }

  parseResponse(prepared: PreparedSefazExchange, soap: Buffer): SefazResponse {
    return parseSefazSoapResponse({
      service: prepared.service,
      soap,
      ...(prepared.expectedAccessKey ? { expectedAccessKey: prepared.expectedAccessKey } : {}),
      ...(prepared.expectedReceipt ? { expectedReceipt: prepared.expectedReceipt } : {}),
      expectedOperation: prepared.operation,
      expectedOperationNamespace: prepared.operationNamespace,
    })
  }
}

function onlyElement(xml: Buffer, name: string): XmlElement {
  const errors: string[] = []
  const document = new DOMParser({
    onError: (_level, message) => errors.push(message),
  }).parseFromString(xml.toString('utf8'), 'application/xml')
  const nodes = document.getElementsByTagNameNS(nfeNamespace, name)
  const element = nodes.item(0)
  if (errors.length > 0 || nodes.length !== 1 || !element)
    throw new Error(`Signed SEFAZ request requires exactly one ${name}`)
  return element
}

function assertSignedElement(xml: Buffer, name: string, expected: string): void {
  if (onlyElement(xml, name).textContent?.trim() !== expected)
    throw new Error(`Signed SEFAZ request ${name} differs from the expected tuple`)
}

function assertSignedField(
  xml: Buffer,
  element: string,
  attribute: string,
  expected: string,
): void {
  if (onlyElement(xml, element).getAttribute(attribute) !== expected)
    throw new Error(`Signed SEFAZ request ${attribute} differs from the expected tuple`)
}
