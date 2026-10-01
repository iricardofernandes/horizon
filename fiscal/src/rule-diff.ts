import type { FiscalRuleDiff, FiscalRuleSummary } from '@horizon/contracts'
import { canonicalJson } from './canonical-json'

type Entry = FiscalRuleDiff['entries'][number]

/** What a rule is, apart from its identity: two versions that say the same are unchanged. */
const COMPARED_FIELDS = [
  'group',
  'code',
  'precedence',
  'priority',
  'model',
  'environment',
  'purpose',
  'scope',
  'effectiveFrom',
  'effectiveTo',
  'rate',
  'formula',
  'expression',
  'sourceLocator',
] as const satisfies readonly (keyof FiscalRuleSummary)[]

/**
 * The rules from `before` (today, or another package) to `after`, key by key (Phase 88). A
 * key only before is ended; a key only after is added. A key on both sides is ended when only
 * its window now closes earlier, changed when anything else differs, and unchanged otherwise.
 */
export function diffRules(
  before: readonly FiscalRuleSummary[],
  after: readonly FiscalRuleSummary[],
  against: FiscalRuleDiff['against'],
): FiscalRuleDiff {
  const latest = (rules: readonly FiscalRuleSummary[]) => {
    const byKey = new Map<string, FiscalRuleSummary>()
    for (const rule of rules) {
      const held = byKey.get(rule.ruleKey)
      if (!held || held.version < rule.version) byKey.set(rule.ruleKey, rule)
    }
    return byKey
  }
  const old = latest(before)
  const next = latest(after)
  const keys = [...new Set([...old.keys(), ...next.keys()])].sort()
  const entries = keys.map((ruleKey): Entry => {
    const was = old.get(ruleKey) ?? null
    const is = next.get(ruleKey) ?? null
    if (!was) return { ruleKey, change: 'added', before: null, after: is, fields: [] }
    if (!is) return { ruleKey, change: 'ended', before: was, after: null, fields: [] }
    const fields = COMPARED_FIELDS.filter(
      (field) => canonicalJson(was[field] ?? null) !== canonicalJson(is[field] ?? null),
    ).map((field) => ({ field, before: was[field] ?? null, after: is[field] ?? null }))
    return { ruleKey, change: changeOf(fields, was, is), before: was, after: is, fields }
  })
  const count = (change: Entry['change']) =>
    entries.filter((entry) => entry.change === change).length
  return {
    against,
    entries,
    counts: {
      added: count('added'),
      ended: count('ended'),
      changed: count('changed'),
      unchanged: count('unchanged'),
    },
  }
}

function changeOf(
  fields: readonly { field: string }[],
  was: FiscalRuleSummary,
  is: FiscalRuleSummary,
): Entry['change'] {
  if (fields.length === 0) return 'unchanged'
  const closesEarlier =
    is.effectiveTo !== null && (was.effectiveTo === null || is.effectiveTo < was.effectiveTo)
  return fields.length === 1 && fields[0]?.field === 'effectiveTo' && closesEarlier
    ? 'ended'
    : 'changed'
}
