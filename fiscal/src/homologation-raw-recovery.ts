import type { HomologationExchangeLedger } from './homologation-exchange-ledger'
import type { SefazNfe55HomologationAdapter, SefazOperationMap } from './nfe55/sefaz-adapter'
import type { SefazResponseSchemaValidator } from './nfe55/sefaz-response-schema'

/** Parses retained response bytes after a crash without requiring a live signer. */
export class HomologationRawRecovery {
  constructor(
    private readonly ledger: Pick<
      HomologationExchangeLedger,
      'loadPrepared' | 'recordParsedResponse'
    >,
    private readonly parser: Pick<
      SefazNfe55HomologationAdapter,
      'parseResponse' | 'wsdlDigest' | 'adapterVersion'
    >,
    private readonly responseSchemas: Pick<SefazResponseSchemaValidator, 'validate'>,
  ) {}

  async reparse(
    tenantId: string,
    exchangeId: string,
    actorId: string,
    operations: SefazOperationMap,
  ) {
    const loaded = await this.ledger.loadPrepared(tenantId, exchangeId, operations, actorId)
    if (
      loaded.input.wsdlDigest !== this.parser.wsdlDigest ||
      loaded.input.adapterVersion !== this.parser.adapterVersion
    )
      throw new Error('Stored SEFAZ runtime binding differs from response parser')
    if (loaded.stage !== 'raw_unparsed' || !loaded.rawResponse)
      throw new Error('SEFAZ exchange has no unparsed stored response')
    const response = this.parser.parseResponse(loaded.prepared, loaded.rawResponse)
    await this.responseSchemas.validate(loaded.prepared.service, response.payload)
    await this.ledger.recordParsedResponse(
      loaded.input.tenantId,
      loaded.input.documentId,
      loaded.input.exchangeId,
      response,
    )
    return response
  }
}
