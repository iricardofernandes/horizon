import { dataSubjectErased, type EventEnvelope, partyErased } from '@horizon/contracts'
import type { AttachmentLifecycle } from '@/application/lifecycle'
import type { EventHandler } from './rabbitmq-transport'

/**
 * What `files` learns from elsewhere: only that an owner was erased (ADR 0060). A party's
 * erasure shreds the files about it; a user's, the files they uploaded under their own key.
 */
export function erasureHandlers(
  lifecycle: AttachmentLifecycle,
): Readonly<Record<string, EventHandler>> {
  return {
    'parties.party.erased': async (event: EventEnvelope) => {
      const parsed = partyErased.envelope.parse(event)
      await lifecycle.eraseOwner(
        {
          tenantId: parsed.tenantId,
          sourceModule: 'parties',
          eventId: parsed.eventId,
          eventType: parsed.eventType,
        },
        { type: 'party', id: parsed.payload.partyId },
      )
    },
    'identity.data-subject.erased': async (event: EventEnvelope) => {
      const parsed = dataSubjectErased.envelope.parse(event)
      await lifecycle.eraseOwner(
        {
          tenantId: parsed.tenantId,
          sourceModule: 'identity',
          eventId: parsed.eventId,
          eventType: parsed.eventType,
        },
        { type: 'user', id: parsed.payload.subjectId },
      )
    },
  }
}
