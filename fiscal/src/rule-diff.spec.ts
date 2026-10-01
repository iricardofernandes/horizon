import type { FiscalRuleSummary } from '@horizon/contracts'
import { describe, expect, it } from 'vitest'
import { diffRules } from './rule-diff'

const rule = (over: Partial<FiscalRuleSummary> = {}): FiscalRuleSummary => ({
  id: '018f5d4e-1000-7000-8000-000000000001',
  ruleKey: 'icms.sp',
  version: 1,
  group: 'legacy',
  code: 'ICMS',
  precedence: 'operation',
  priority: 500,
  model: '55',
  environment: 'simulation',
  purpose: 'normal',
  scope: { operation: 'sale', originState: '35' },
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  rate: { numerator: '18', denominator: '100' },
  formula: 'LINE_NET_TIMES_RATE',
  expression: null,
  sourceLocator: 'RICMS-SP art. 52',
  definitionDigest: 'a'.repeat(64),
  ...over,
})
const against = { kind: 'workspace' } as const

describe('the diff of a rule change (Phase 88)', () => {
  it('names a key only after as added, and only before as ended', () => {
    const diff = diffRules([rule()], [rule({ ruleKey: 'ipi' })], against)
    expect(diff.entries.map((entry) => [entry.ruleKey, entry.change])).toEqual([
      ['icms.sp', 'ended'],
      ['ipi', 'added'],
    ])
    expect(diff.counts).toEqual({ added: 1, ended: 1, changed: 0, unchanged: 0 })
  })

  it('calls a window that now closes earlier ended, and anything else that differs changed', () => {
    const closing = diffRules([rule()], [rule({ version: 2, effectiveTo: '2027-01-01' })], against)
    expect(closing.entries[0]).toMatchObject({
      change: 'ended',
      fields: [{ field: 'effectiveTo', before: null, after: '2027-01-01' }],
    })
    const reopening = diffRules(
      [rule({ effectiveTo: '2027-01-01' })],
      [rule({ version: 2 })],
      against,
    )
    expect(reopening.entries[0]?.change).toBe('changed')
    const rate = diffRules(
      [rule()],
      [rule({ version: 2, rate: { numerator: '20', denominator: '100' } })],
      against,
    )
    expect(rate.entries[0]).toMatchObject({
      change: 'changed',
      fields: [
        {
          field: 'rate',
          before: { numerator: '18', denominator: '100' },
          after: { numerator: '20', denominator: '100' },
        },
      ],
    })
  })

  it('compares the latest version of each key, and a new version that says the same is unchanged', () => {
    const diff = diffRules(
      [rule(), rule({ version: 2, rate: { numerator: '20', denominator: '100' } })],
      [
        rule({
          version: 3,
          rate: { numerator: '20', denominator: '100' },
          definitionDigest: 'b'.repeat(64),
        }),
      ],
      against,
    )
    expect(diff.entries).toMatchObject([{ change: 'unchanged', fields: [] }])
  })
})
