import type { HomologationExchangeLedger } from './homologation-exchange-ledger'
import type { PreparedSefazExchange, SefazNfe55HomologationAdapter } from './nfe55/sefaz-adapter'
import type { SefazResponseSchemaValidator } from './nfe55/sefaz-response-schema'
import type { SefazResponse } from './nfe55/sefaz-soap'
import type { SefazService } from './nfe55/sefaz-transport'

type PreparedInput = Parameters<HomologationExchangeLedger['prepare']>[0]

export class UncertainSefazOutcomeError extends Error {
  constructor() {
    super('SEFAZ exchange outcome is uncertain; consult before any further submission')
    this.name = 'UncertainSefazOutcomeError'
  }
}

/** Runs one already validated envelope through an append-only send boundary. */
export class HomologationExchangeRunner {
  constructor(
    private readonly ledger: Pick<
      HomologationExchangeLedger,
      'prepare' | 'markStarted' | 'recordRawResponse' | 'recordParsedResponse'
    >,
    private readonly transport: {
      endpointSetDigest: string
      certificateFingerprint: string
      send(service: SefazService, envelope: Buffer): Promise<Buffer>
    },
    private readonly parser: Pick<SefazNfe55HomologationAdapter, 'parseResponse' | 'wsdlDigest'>,
    private readonly responseSchemas: Pick<SefazResponseSchemaValidator, 'validate'>,
  ) {}

  async execute(
    input: PreparedInput & { workerId: string },
    prepared: PreparedSefazExchange,
  ): Promise<SefazResponse> {
    if (
      input.endpointDigest !== this.transport.endpointSetDigest ||
      input.certificateFingerprint !== this.transport.certificateFingerprint ||
      input.wsdlDigest !== this.parser.wsdlDigest
    )
      throw new Error('SEFAZ runtime binding differs from the approved drill grant')
    const { workerId, ...evidence } = input
    await this.ledger.prepare(evidence, prepared)
    if (!(await this.ledger.markStarted(input.tenantId, input.exchangeId, workerId)))
      throw new UncertainSefazOutcomeError()
    let bytes: Buffer
    try {
      bytes = await this.transport.send(prepared.service, prepared.request)
    } catch {
      throw new UncertainSefazOutcomeError()
    }
    await this.ledger.recordRawResponse(input.tenantId, input.documentId, input.exchangeId, bytes)
    const parsed = this.parser.parseResponse(prepared, bytes)
    await this.responseSchemas.validate(prepared.service, parsed.payload)
    await this.ledger.recordParsedResponse(
      input.tenantId,
      input.documentId,
      input.exchangeId,
      parsed,
    )
    return parsed
  }
}
