import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { consistencyRunSchema } from './consistency'

describe('a consistency run', () => {
  it('carries each check with its differences', () => {
    const run = {
      runId: randomUUID(),
      trigger: 'scheduled',
      outcome: 'inconsistent',
      checks: [
        {
          check: 'receivables-control',
          outcome: 'differences',
          compared: 1,
          differences: [{ key: 'BRL', owner: '150000', ledger: '160000' }],
          reason: null,
        },
        {
          check: 'inventory-accounts',
          outcome: 'not-applicable',
          compared: 0,
          differences: [],
          reason: 'no ledger account is mapped to inventory',
        },
      ],
      pendingPostings: 0,
      startedBy: 'service:reporting',
      startedAt: '2026-09-28T02:00:00.000Z',
      finishedAt: '2026-09-28T02:00:04.000Z',
    }
    expect(consistencyRunSchema.parse(run)).toEqual(run)
    expect(
      consistencyRunSchema.safeParse({
        ...run,
        checks: [{ ...run.checks[0], check: 'vibes' }],
      }).success,
    ).toBe(false)
  })
})
