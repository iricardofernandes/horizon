import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cutoffOf, policySchema } from './policy.js'
import { runRetention } from './retention.js'

const rule = {
  class: 'delivery-bookkeeping',
  database: 'financial',
  table: 'inbox',
  ageColumn: 'received_at',
  keepDays: 90,
} as const

describe('the retention policy', () => {
  it('reads the declared policy, which names only delivery bookkeeping', () => {
    const policy = policySchema.parse(JSON.parse(readFileSync('policy.json', 'utf8')))
    expect(new Set(policy.rules.map((entry) => entry.table))).toEqual(
      new Set(['inbox', 'command_receipts']),
    )
    expect(policy.rules.every((entry) => entry.keepDays >= 30)).toBe(true)
  })

  it('refuses a table retention never removes, a bad identifier and a short age', () => {
    const policy = (rules: unknown[]) => policySchema.safeParse({ rules, reports: {} })
    expect(policy([rule]).success).toBe(true)
    expect(policy([{ ...rule, table: 'audit_log' }]).success).toBe(false)
    expect(policy([{ ...rule, table: 'outbox' }]).success).toBe(false)
    expect(policy([{ ...rule, table: 'inbox; drop table x' }]).success).toBe(false)
    expect(policy([{ ...rule, keepDays: 1 }]).success).toBe(false)
  })

  it('counts its age back from now', () => {
    expect(cutoffOf(rule, new Date('2026-09-28T00:00:00.000Z')).toISOString()).toBe(
      '2026-06-30T00:00:00.000Z',
    )
  })
})

describe('a retention run', () => {
  it('logs a failed rule and still runs the rest, and reports what it only watches', async () => {
    const lines: Record<string, unknown>[] = []
    const failing = () =>
      Object.assign(async () => Promise.reject(new Error('down')), { length: 0 })
    const outcome = await runRetention(
      policySchema.parse({ rules: [rule], reports: { redisPrefixes: ['identity:denylist:'] } }),
      { database: () => Object.assign(failing, { unsafe: failing }) as never },
      {
        overdue: async () => ({ exports: 0 }),
        keysWithoutTtl: async () => ({ 'identity:denylist:': 0 }),
      },
      (line) => lines.push(line),
    )
    expect(outcome.failed).toEqual(['financial.inbox'])
    expect(lines.at(-1)).toMatchObject({
      event: 'retention.run',
      removed: 0,
      overdue: { exports: 0 },
      keysWithoutTtl: { 'identity:denylist:': 0 },
    })
  })
})
