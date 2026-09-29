import { dataSubjectErased, type EventEnvelope } from '@horizon/contracts'
import type { AssistantStore } from '@/application/assistant-ports'
import type { EventHandler } from './rabbitmq-consumer'

/**
 * What the agent learns from elsewhere (Phase 76): only that a person was erased. Their key
 * is destroyed and their conversations deleted (ADR 0068).
 */
export function erasureHandlers(store: AssistantStore): Readonly<Record<string, EventHandler>> {
  return {
    'identity.data-subject.erased': async (event: EventEnvelope) => {
      const parsed = dataSubjectErased.envelope.parse(event)
      await store.erase(
        {
          tenantId: parsed.tenantId,
          sourceModule: 'identity',
          eventId: parsed.eventId,
          eventType: parsed.eventType,
        },
        parsed.payload.subjectId,
      )
    },
  }
}
