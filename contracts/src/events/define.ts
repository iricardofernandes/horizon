import type { z } from 'zod'

import { envelopeOf, eventTypeSchema } from '../envelope'

/**
 * One event definition: its name, its version, its payload schema, and the prose that
 * ends up in `docs/events.md`.
 *
 * Definitions are declared through this helper rather than assembled by hand so that
 * every event carries a description — the generated catalogue is only useful if it says
 * what an event *means*, not merely what fields it has — and so the registry has a
 * single shape for the snapshot and documentation generators to walk.
 */
export interface EventDefinition<T extends z.ZodType = z.ZodType> {
  readonly type: string
  readonly version: number
  readonly description: string
  readonly payload: T
  /** The full envelope with `payload` narrowed to this event's schema. */
  readonly envelope: ReturnType<typeof envelopeOf<T>>
  /** Stable identifier used by the registry, the snapshot and the compatibility gate. */
  readonly id: string
}

export function defineEvent<T extends z.ZodType>(definition: {
  type: string
  version: number
  description: string
  payload: T
}): EventDefinition<T> {
  const parsed = eventTypeSchema.safeParse(definition.type)
  if (!parsed.success) {
    throw new Error(
      `invalid event type "${definition.type}": ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    )
  }

  return {
    ...definition,
    envelope: envelopeOf(definition.payload),
    id: `event:${definition.type}:v${definition.version}`,
  }
}
