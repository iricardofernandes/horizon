import {
  type EventEnvelope,
  filesAttachmentAvailable,
  filesAttachmentDeleted,
  filesAttachmentQuarantined,
} from '@horizon/contracts'
import type { Indexing } from '@/application/indexing'
import type { EventHandler } from './rabbitmq-consumer'

const received = (event: { tenantId: string; eventId: string; eventType: string }) => ({
  tenantId: event.tenantId,
  sourceModule: 'files',
  eventId: event.eventId,
  eventType: event.eventType,
})

/**
 * What the index learns (Phase 74): a file is available, or it ended. Every erasure of an
 * owner reaches it as one `deleted` per file (ADR 0068), and a quarantined file never
 * enters it.
 */
export function indexHandlers(indexing: Indexing): Readonly<Record<string, EventHandler>> {
  return {
    'files.attachment.available': async (event: EventEnvelope) => {
      const parsed = filesAttachmentAvailable.envelope.parse(event)
      await indexing.available(received(parsed), parsed.payload)
    },
    'files.attachment.deleted': async (event: EventEnvelope) => {
      const parsed = filesAttachmentDeleted.envelope.parse(event)
      await indexing.ended(received(parsed), parsed.payload, parsed.payload.reason)
    },
    'files.attachment.quarantined': async (event: EventEnvelope) => {
      const parsed = filesAttachmentQuarantined.envelope.parse(event)
      await indexing.ended(received(parsed), parsed.payload, 'quarantined')
    },
  }
}
