import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { FiscalCapabilities } from './capabilities'
import type { HomologationExchangeLedger } from './homologation-exchange-ledger'
import { serializeCancellationEvent, signCancellationEvent } from './nfe55/cancellation-event'
import type { HomologationCredential } from './nfe55/homologation-credential'
import type { SefazNfe55HomologationAdapter } from './nfe55/sefaz-adapter'

const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  exchangeId: z.uuid(),
  actorId: z.string().min(1).max(200),
  reason: z.string().trim().min(15).max(255),
  occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/),
})

/** Freezes a signed cancellation event against an observed authorization protocol. */
export class HomologationCancellation {
  constructor(
    private readonly ledger: Pick<HomologationExchangeLedger, 'cancellationTarget' | 'prepare'>,
    private readonly capabilities: Pick<FiscalCapabilities, 'getHomologationEventSchemaDigest'>,
    private readonly adapter: Pick<
      SefazNfe55HomologationAdapter,
      'prepare' | 'wsdlDigest' | 'certificateFingerprint' | 'adapterVersion'
    >,
    private readonly credential: HomologationCredential,
    private readonly schemaZip: Buffer,
  ) {}

  async prepare(input: z.input<typeof commandSchema>) {
    const command = commandSchema.parse(input)
    const target = await this.ledger.cancellationTarget(
      command.tenantId,
      command.documentId,
      command.exchangeId,
    )
    const schemaDigest = createHash('sha256').update(this.schemaZip).digest('hex')
    const reviewedDigest = await this.capabilities.getHomologationEventSchemaDigest(
      command.tenantId,
      target.capabilityId,
    )
    if (!reviewedDigest || reviewedDigest !== schemaDigest)
      throw new Error('Reviewed homologation cancellation schema is unavailable or differs')
    if (
      target.wsdlDigest !== this.adapter.wsdlDigest ||
      target.adapterVersion !== this.adapter.adapterVersion ||
      target.certificateFingerprint !== this.adapter.certificateFingerprint ||
      target.certificateFingerprint !== this.credential.fingerprint
    )
      throw new Error('Homologation cancellation runtime differs from authorization')
    if (target.accessKey.slice(6, 20) !== this.credential.issuerTaxId)
      throw new Error('Homologation cancellation issuer differs from certificate')
    if (this.credential.validUntil <= Date.now() + this.credential.minimumRemainingMilliseconds)
      throw new Error('Homologation certificate is expiring')
    const signedEvent = signCancellationEvent(
      serializeCancellationEvent({
        accessKey: target.accessKey,
        authorizationProtocol: target.protocolNumber,
        reason: command.reason,
        occurredAt: command.occurredAt,
        lotId: target.accessKey.slice(25, 34),
      }),
      this.credential,
    )
    const prepared = await this.adapter.prepare({
      service: 'event',
      accessKey: target.accessKey,
      signedEvent,
      schemaZip: this.schemaZip,
      schemaDigest,
    })
    const recorded = await this.ledger.prepare(
      {
        tenantId: command.tenantId,
        documentId: command.documentId,
        exchangeId: command.exchangeId,
        drillGrantId: target.drillGrantId,
        parentExchangeId: target.parentExchangeId,
        endpointDigest: target.endpointDigest,
        wsdlDigest: target.wsdlDigest,
        certificateFingerprint: target.certificateFingerprint,
        adapterVersion: target.adapterVersion,
        actorId: command.actorId,
      },
      prepared,
    )
    return {
      exchangeId: recorded.exchangeId,
      requestDigest: recorded.requestDigest,
      accessKey: target.accessKey,
      authorizationProtocol: target.protocolNumber,
    }
  }
}
