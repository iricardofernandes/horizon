import type { EventDefinition } from './define'
import { tenantCreated } from './identity'

export * from './define'
export * from './identity'

/**
 * Every event Horizon publishes.
 *
 * `docs/events.md` is generated from this, so the catalogue cannot drift from the code,
 * and the compatibility gate walks it to compare each payload against the last published
 * version (ADR 0030).
 */
export const EVENTS: readonly EventDefinition[] = [tenantCreated] as const

/** Look up an event definition by `eventType` and `eventVersion`. */
export function findEvent(type: string, version: number): EventDefinition | undefined {
  return EVENTS.find((event) => event.type === type && event.version === version)
}
