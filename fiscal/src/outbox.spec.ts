import { describe, expect, it } from 'vitest'
import { occurredAt } from './outbox'

describe('when a relayed Fiscal event happened', () => {
  it('reads an authority observation from its payload', () => {
    expect(occurredAt({ observedAt: '2026-10-01T12:00:00.000Z' }, new Date())).toBe(
      '2026-10-01T12:00:00.000Z',
    )
  })

  it('takes the commit time for an event that states none, such as a lock (Phase 89)', () => {
    // Before Phase 89 this threw, and the lock event stopped every later event of its workspace.
    expect(occurredAt({ documentId: 'x' }, new Date('2026-10-01T14:54:31.758Z'))).toBe(
      '2026-10-01T14:54:31.758Z',
    )
  })
})
