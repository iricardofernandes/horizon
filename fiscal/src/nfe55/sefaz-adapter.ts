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

export type SefazExchange = { request: Buffer; response: SefazResponse }
export type PreparedSefazExchange = {
  service: SefazService
  request: Buffer
  operation: string
  operationNamespace: string
  expectedAccessKey?: string
  expectedReceipt?: string
}

/** Performs one exchange. It never retries an ambiguous authorization or event submission. */
export class SefazNfe55HomologationAdapter {
  constructor(
    private readonly transport: {
      send(service: SefazService, soapEnvelope: Buffer): Promise<Buffer>
    },
    private readonly credential: Pick<HomologationCredential, 'certificate'>,
    private readonly operations: SefazOperationMap,
  ) {
    digestSchema.parse(operations.wsdlDigest)
  }

  async prepare(input: SefazExchangeInput): Promise<PreparedSefazExchange> {
    if (input.service !== 'status') {
      accessKeySchema.parse(input.accessKey)
      if (input.accessKey.slice(0, 2) !== '35')
        throw new Error('SEFAZ adapter requires an SP access key')
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

  async exchange(input: SefazExchangeInput): Promise<SefazExchange> {
    const prepared = await this.prepare(input)
    const soap = await this.transport.send(prepared.service, prepared.request)
    return { request: prepared.request, response: this.parseResponse(prepared, soap) }
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
