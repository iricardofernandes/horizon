import {
  catalogItemClassificationChanged,
  catalogItemCreated,
  type EventEnvelope,
  financialPayablePosted,
  financialPayableReversed,
  partyErased,
} from '@horizon/contracts'
import type { ExampleIndex } from '@/application/suggestions'
import type { EventHandler } from './rabbitmq-consumer'

/** The inbox key: the producing module is the event type's first word. */
const received = (event: { tenantId: string; eventId: string; eventType: string }) => ({
  tenantId: event.tenantId,
  sourceModule: event.eventType.split('.')[0] ?? 'unknown',
  eventId: event.eventId,
  eventType: event.eventType,
})

/**
 * What the suggestions learn (Phase 77): items named and classified, payables posted and
 * reversed, and parties erased, whose payable examples go with them (ADR 0068).
 */
export function exampleHandlers(index: ExampleIndex): Readonly<Record<string, EventHandler>> {
  return {
    'catalog.item.created': async (event: EventEnvelope) => {
      const parsed = catalogItemCreated.envelope.parse(event)
      await index.itemCreated(received(parsed), parsed.payload)
    },
    'catalog.item.classification-changed': async (event: EventEnvelope) => {
      const parsed = catalogItemClassificationChanged.envelope.parse(event)
      await index.itemClassified(received(parsed), parsed.payload)
    },
    'financial.payable.posted': async (event: EventEnvelope) => {
      const parsed = financialPayablePosted.envelope.parse(event)
      await index.payablePosted(received(parsed), parsed.payload)
    },
    'financial.payable.reversed': async (event: EventEnvelope) => {
      const parsed = financialPayableReversed.envelope.parse(event)
      await index.payableReversed(received(parsed), parsed.payload)
    },
    'parties.party.erased': async (event: EventEnvelope) => {
      const parsed = partyErased.envelope.parse(event)
      await index.partyErased(received(parsed), parsed.payload)
    },
  }
}
