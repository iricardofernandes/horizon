import type { FiscalTaxSupportRow } from '@horizon/contracts'
import type { z } from 'zod'
import { approvedPhase41Source } from './phase41-approved-scenario'
import { approvedPhase45Source } from './phase45-approved-scenario'
import { approvedPhase46Source } from './phase46-approved-scenario'
import { approvedPhase47IbsCbsSource, approvedPhase47IssSource } from './phase47-approved-scenario'
import type { taxRuleImportSchema } from './rule-rows'

/**
 * The scenarios Phases 41 to 47 approved before the support matrix existed (Phase 87): each
 * one's reviewed rules, grouped by everything but the component, become the rows that say
 * which taxes a document of that scenario carries. They are read from the approved sources
 * themselves, so a row cannot say more than the review did.
 */

type Rule = z.input<typeof taxRuleImportSchema>
const ANY_TENANT = '00000000-0000-4000-8000-000000000000'

export type ApprovedScenarioEvidence = { phase: string; reference: string; digest: string }

function rowsOf(
  rules: readonly Rule[],
  evidence: ApprovedScenarioEvidence,
  override: Partial<Pick<Rule, 'environment'>> & { anyState?: boolean } = {},
): FiscalTaxSupportRow[] {
  const groups = new Map<string, { rule: Rule; taxes: Set<string> }>()
  for (const rule of rules) {
    const scoped = {
      ...rule,
      ...(override.environment ? { environment: override.environment } : {}),
      ...(override.anyState ? { originState: undefined, destinationState: undefined } : {}),
    }
    const key = JSON.stringify([
      scoped.model,
      scoped.environment,
      scoped.operation ?? '',
      scoped.purpose ?? 'normal',
      scoped.originState ?? '',
      scoped.destinationState ?? '',
      scoped.issuerRegime ?? '',
      scoped.classification ?? null,
      scoped.effectiveFrom,
      scoped.effectiveTo ?? '',
    ])
    const group = groups.get(key) ?? { rule: scoped, taxes: new Set<string>() }
    group.taxes.add(rule.code)
    groups.set(key, group)
  }
  return [...groups.values()].map(({ rule, taxes }) => ({
    id: [
      'approved',
      evidence.phase,
      rule.environment,
      rule.operation ?? 'any',
      rule.purpose ?? 'normal',
      rule.classification ? `${rule.classification.kind}-${rule.classification.code}` : 'any',
    ].join(':'),
    model: rule.model,
    environment: rule.environment,
    from: rule.effectiveFrom,
    until: rule.effectiveTo ?? '9999-12-31',
    taxes: [...taxes].sort(),
    dimensions: {
      ...(rule.classification
        ? {
            classification: rule.classification as {
              kind: 'ncm' | 'service' | 'class_trib'
              code: string
            },
          }
        : {}),
      ...(rule.operation ? { operation: rule.operation } : {}),
      purpose: rule.purpose ?? 'normal',
      ...(rule.originState ? { originState: rule.originState } : {}),
      ...(rule.destinationState ? { destinationState: rule.destinationState } : {}),
      ...(rule.issuerRegime ? { issuerRegime: rule.issuerRegime } : {}),
    },
    evidence: { kind: 'approved-scenario', reference: evidence.reference, digest: evidence.digest },
  }))
}

/**
 * Phase 41's sale, re-scoped for Phase 43's homologation drills (any UF, as each drill
 * re-scopes it to its own); Phase 45's linked documents; Phase 46's NFC-e; Phase 47's NFS-e
 * for São Paulo (CBS, IBS and the provisional ISS) and Campinas (CBS and IBS).
 */
export function approvedScenarioRows(
  evidence: Record<'41' | '43' | '45' | '46' | '47', Omit<ApprovedScenarioEvidence, 'phase'>>,
): FiscalTaxSupportRow[] {
  const phase41 = approvedPhase41Source(ANY_TENANT, { byteSize: 1, storageUri: 'file:///rows' })
    .rules as Rule[]
  const with_ = (phase: keyof typeof evidence) => ({ phase, ...evidence[phase] })
  return [
    ...rowsOf(phase41, with_('41')),
    ...rowsOf(phase41, with_('43'), { environment: 'homologation', anyState: true }),
    ...rowsOf(approvedPhase45Source(ANY_TENANT).rules as Rule[], with_('45')),
    ...rowsOf(approvedPhase46Source(ANY_TENANT).rules as Rule[], with_('46')),
    ...rowsOf(
      [
        ...approvedPhase47IbsCbsSource(ANY_TENANT, '3550308').rules,
        ...approvedPhase47IssSource(ANY_TENANT, '3550308').rules,
        ...approvedPhase47IbsCbsSource(ANY_TENANT, '3509502').rules,
      ] as Rule[],
      with_('47'),
    ),
  ].sort((left, right) => left.id.localeCompare(right.id))
}
