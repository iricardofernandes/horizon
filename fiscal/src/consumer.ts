import { type EventEnvelope, eventEnvelopeSchema, findEvent } from '@horizon/contracts'
import { type Channel, type ChannelModel, type ConsumeMessage, connect } from 'amqplib'
import type { OwnerFiscalClient } from './backfill'
import { FISCAL_EVENT_TYPES, type FiscalIngress } from './ingress'
import type { FiscalProjections } from './projections'

/** Durable RabbitMQ consumer: validate, claim inbox, resolve exact owner revision, ack. */
export class FiscalConsumer {
  private connection: ChannelModel | undefined
  private channel: Channel | undefined
  private consumerTag: string | undefined

  constructor(
    private readonly brokerUrl: string,
    private readonly ingress: FiscalIngress,
    private readonly projections: FiscalProjections,
    private readonly ownerForTenant: (tenantId: string) => OwnerFiscalClient,
    private readonly queue = 'fiscal.events',
  ) {}

  async start(): Promise<void> {
    this.connection = await connect(this.brokerUrl, { timeout: 5000 })
    const channel = await this.connection.createChannel()
    this.channel = channel
    const deadLetterExchange = `${this.queue}.dlx`
    await channel.assertExchange('horizon.events', 'topic', { durable: true })
    // The queue dead-letters into an exchange of its own (Phase 90). Fiscal's broker user may
    // write only to its own names, and a shared exchange would let any module place a message
    // in another module's dead-letter queue.
    await channel.assertExchange(deadLetterExchange, 'fanout', { durable: true })
    await channel.assertQueue(`${this.queue}.dlq`, { durable: true })
    await channel.bindQueue(`${this.queue}.dlq`, deadLetterExchange, '')
    await channel.assertQueue(this.queue, { durable: true, deadLetterExchange })
    for (const type of FISCAL_EVENT_TYPES)
      await channel.bindQueue(this.queue, 'horizon.events', type)
    await channel.prefetch(20)
    const { consumerTag } = await channel.consume(this.queue, (message) => {
      if (message) void this.dispatch(channel, message)
    })
    this.consumerTag = consumerTag
  }

  async close(): Promise<void> {
    if (this.consumerTag) await this.channel?.cancel(this.consumerTag)
    await this.channel?.close()
    await this.connection?.close()
  }

  private async dispatch(channel: Channel, message: ConsumeMessage): Promise<void> {
    const event = this.parse(message)
    if (!event || !routedAs(message, event.eventType)) {
      channel.nack(message, false, false)
      return
    }
    try {
      await this.ingress.accept(event)
      if (event.eventType === 'parties.party.fiscal-profile-changed') {
        const payload = event.payload as { partyId: string; revision: number }
        const record = await this.ownerForTenant(event.tenantId).partyRevision(
          payload.partyId,
          payload.revision,
        )
        await this.projections.storeParty(event.tenantId, payload.partyId, payload.revision, record)
      }
      if (event.eventType === 'identity.company.fiscal-profile-changed') {
        const payload = event.payload as { revision: number }
        const record = await this.ownerForTenant(event.tenantId).issuerRevision(payload.revision)
        await this.projections.storeIssuer(event.tenantId, payload.revision, record)
      }
      channel.ack(message)
    } catch (error) {
      console.error('Fiscal event handling failed', {
        eventType: event.eventType,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        retry: !message.fields.redelivered,
      })
      channel.nack(message, false, !message.fields.redelivered)
    }
  }

  private parse(message: ConsumeMessage): EventEnvelope | null {
    try {
      const event = eventEnvelopeSchema.parse(JSON.parse(message.content.toString()))
      if (!FISCAL_EVENT_TYPES.some((type) => type === event.eventType)) return null
      const contract = findEvent(event.eventType, event.eventVersion)
      if (!contract) return null
      contract.payload.parse(event.payload)
      return event
    } catch {
      console.error('Fiscal event rejected', { messageId: message.properties.messageId })
      return null
    }
  }
}

/**
 * A message is the event it was published as (Phase 90). Each module's broker user may
 * publish only its own routing keys, so a module that sends another module's event under a
 * key of its own is refused here. A message from the default exchange was put back by an
 * operator: no module may write there.
 */
function routedAs(message: ConsumeMessage, eventType: string): boolean {
  return message.fields.exchange === '' || message.fields.routingKey === eventType
}
