import { randomUUID } from 'node:crypto'
import { EVENTS, REPORTING_REPLAY_QUEUE } from '@horizon/contracts'
import { InMemoryJournal } from 'test/repositories/in-memory-journal'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { REDACTED_FIELDS, sourceOf } from '@/domain/journal'
import { JOURNALED_EVENT_TYPES, JournalIntake, Undeliverable } from './journal-intake'

const tenantId = randomUUID()
const now = new Date('2026-09-27T12:10:00Z')

function event(occurredAt: string, overrides: Record<string, unknown> = {}) {
  return {
    eventId: randomUUID(),
    tenantId,
    eventType: 'catalog.item.deactivated',
    eventVersion: 1,
    occurredAt,
    traceId: 'a'.repeat(32),
    payload: { itemId: randomUUID() },
    ...overrides,
  }
}

function seal(through: string, count: number, source = 'catalog') {
  return {
    kind: 'seal',
    sealId: randomUUID(),
    source,
    tenantId,
    through,
    count,
    sealedAt: '2026-09-27T12:09:00.000Z',
  }
}

function setup() {
  const journal = new InMemoryJournal()
  return { journal, intake: new JournalIntake(journal, { now: () => now }) }
}

/** Every property name a schema can carry, at any depth. */
function fieldsOf(schema: unknown, path = ''): string[] {
  if (typeof schema !== 'object' || schema === null) return []
  const node = schema as Record<string, unknown>
  const own = Object.entries((node.properties as Record<string, unknown>) ?? {}).flatMap(
    ([name, child]) => [`${path}${name}`, ...fieldsOf(child, `${path}${name}.`)],
  )
  const nested = ['items', 'anyOf', 'oneOf', 'allOf'].flatMap((key) =>
    [node[key]].flat().flatMap((child) => fieldsOf(child, path)),
  )
  return [...own, ...nested]
}

describe('journal intake', () => {
  it('binds every event type of the journaled modules and nothing of parties or identity', () => {
    expect(JOURNALED_EVENT_TYPES).toContain('sales.order.placed')
    expect(JOURNALED_EVENT_TYPES).toContain('crm.opportunity.converted')
    expect(JOURNALED_EVENT_TYPES.some((type) => type.startsWith('parties.'))).toBe(false)
    expect(JOURNALED_EVENT_TYPES.some((type) => type.startsWith('identity.'))).toBe(false)
    expect(REPORTING_REPLAY_QUEUE).toBe('reporting.replay')
  })

  it('stores no field that may name a person, in any journaled contract', () => {
    const personal = /^(supplierName|legalName|tradeName|email|phone|address|name)$/
    for (const definition of EVENTS) {
      const source = sourceOf(definition.type)
      if (!source) continue
      const redacted = REDACTED_FIELDS[source] ?? []
      const exposed = fieldsOf(z.toJSONSchema(definition.payload, { io: 'input' }))
        .filter((field) => personal.test(field.split('.').at(-1) ?? ''))
        .filter((field) => !redacted.includes(field))
        // Business names of things, not of people.
        .filter(() => !['catalog', 'treasury', 'ledger'].includes(source))
      expect({ type: definition.type, exposed }).toEqual({ type: definition.type, exposed: [] })
    }
  })

  it('keeps a live event once, and a replayed copy of it changes nothing', async () => {
    const { journal, intake } = setup()
    const live = event('2026-09-27T11:00:00.000Z')
    expect(await intake.live(live)).toBe('journaled')
    expect(await intake.live(live)).toBe('duplicate')
    expect(await intake.replay(live)).toBe('duplicate')
    expect(journal.entries).toHaveLength(1)
    expect(journal.entries[0]?.arrival).toBe('live')
  })

  it('refuses what no retry can fix', async () => {
    const { intake } = setup()
    await expect(intake.live({ nope: true })).rejects.toBeInstanceOf(Undeliverable)
    await expect(
      intake.live(event('2026-09-27T11:00:00.000Z', { eventType: 'catalog.item.vanished' })),
    ).rejects.toThrow(/unknown event/)
    await expect(
      intake.live(event('2026-09-27T11:00:00.000Z', { payload: { itemId: 'not-a-uuid' } })),
    ).rejects.toThrow(/contract/)
    await expect(intake.replay({ kind: 'seal', source: 'catalog' })).rejects.toThrow(/seal/)
  })

  it('moves the watermark on a matching seal, and keeps a mismatch visible', async () => {
    const { journal, intake } = setup()
    await intake.live(event('2026-09-27T11:00:00.000Z'))
    await intake.replay(event('2026-09-27T11:30:00.000Z'))
    await intake.live(event('2026-09-27T12:05:00.000Z'))

    expect(await intake.replay(seal('2026-09-27T11:45:00.000Z', 3))).toEqual({
      outcome: 'mismatched',
      journalCount: 2,
    })
    expect(journal.watermarks.size).toBe(0)

    const matched = seal('2026-09-27T11:45:00.000Z', 2)
    expect(await intake.replay(matched)).toEqual({ outcome: 'matched', journalCount: 2 })
    expect(await intake.replay(matched)).toEqual({ outcome: 'duplicate', journalCount: 2 })
    expect(await intake.replay(seal('2026-09-27T11:10:00.000Z', 1))).toMatchObject({
      outcome: 'matched',
    })
    expect(journal.watermarks.get(`${tenantId}:catalog`)?.through.toISOString()).toBe(
      '2026-09-27T11:45:00.000Z',
    )
    expect(journal.seals.map((recorded) => recorded.outcome)).toEqual([
      'mismatched',
      'matched',
      'matched',
    ])
  })

  it('refuses a seal inside the margin and one from a module it does not journal', async () => {
    const { journal, intake } = setup()
    expect(await intake.replay(seal('2026-09-27T12:09:00.000Z', 0))).toMatchObject({
      outcome: 'refused',
    })
    expect(await intake.replay(seal('2026-09-27T11:00:00.000Z', 0, 'parties'))).toEqual({
      outcome: 'refused',
      journalCount: null,
    })
    expect(journal.watermarks.size).toBe(0)
  })
})
