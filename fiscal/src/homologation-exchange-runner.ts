import type { HomologationExchangeLedger } from './homologation-exchange-ledger'
import type {
  PreparedSefazExchange,
  SefazNfe55HomologationAdapter,
  SefazOperationMap,
} from './nfe55/sefaz-adapter'
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
      | 'prepare'
      | 'markStarted'
      | 'recordRawResponse'
      | 'recordParsedResponse'
      | 'loadPrepared'
      | 'assertResponseSchemas'
    >,
    private readonly transport: {
      endpointSetDigest: string
      certificateFingerprint: string
      send(service: SefazService, envelope: Buffer): Promise<Buffer>
    },
    private readonly parser: Pick<
      SefazNfe55HomologationAdapter,
      'parseResponse' | 'wsdlDigest' | 'adapterVersion'
    >,
    private readonly responseSchemas: Pick<
      SefazResponseSchemaValidator,
      'validate' | 'documentDigest' | 'consultationDigest'
    >,
  ) {}

  /** Starts only a prepared exchange or parses already stored response bytes. */
  async resume(
    input: { tenantId: string; exchangeId: string; workerId: string; actorId: string },
    operations: SefazOperationMap,
  ): Promise<SefazResponse> {
    const loaded = await this.ledger.loadPrepared(
      input.tenantId,
      input.exchangeId,
      operations,
      input.actorId,
    )
    if (
      loaded.input.endpointDigest !== this.transport.endpointSetDigest ||
      loaded.input.certificateFingerprint !== this.transport.certificateFingerprint ||
      loaded.input.wsdlDigest !== this.parser.wsdlDigest ||
      loaded.input.adapterVersion !== this.parser.adapterVersion
    )
      throw new Error('SEFAZ runtime binding differs from the approved drill grant')
    await this.ledger.assertResponseSchemas(
      loaded.input.tenantId,
      loaded.input.drillGrantId,
      this.responseSchemas.documentDigest,
      this.responseSchemas.consultationDigest,
    )
    if (loaded.stage === 'observed')
      throw new Error('SEFAZ exchange already has an observed response')
    if (loaded.stage === 'send_started') throw new UncertainSefazOutcomeError()
    if (loaded.stage === 'raw_unparsed') {
      if (!loaded.rawResponse) throw new Error('Stored SEFAZ raw response is unavailable')
      const parsed = this.parser.parseResponse(loaded.prepared, loaded.rawResponse)
      await this.responseSchemas.validate(loaded.prepared.service, parsed.payload)
      await this.ledger.recordParsedResponse(
        loaded.input.tenantId,
        loaded.input.documentId,
        loaded.input.exchangeId,
        parsed,
      )
      return parsed
    }
    return this.execute({ ...loaded.input, workerId: input.workerId }, loaded.prepared)
  }

  async execute(
    input: PreparedInput & { workerId: string },
    prepared: PreparedSefazExchange,
  ): Promise<SefazResponse> {
    if (
      input.endpointDigest !== this.transport.endpointSetDigest ||
      input.certificateFingerprint !== this.transport.certificateFingerprint ||
      input.wsdlDigest !== this.parser.wsdlDigest ||
      input.adapterVersion !== this.parser.adapterVersion
    )
      throw new Error('SEFAZ runtime binding differs from the approved drill grant')
    const { workerId, ...evidence } = input
    await this.ledger.assertResponseSchemas(
      input.tenantId,
      input.drillGrantId,
      this.responseSchemas.documentDigest,
      this.responseSchemas.consultationDigest,
    )
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
