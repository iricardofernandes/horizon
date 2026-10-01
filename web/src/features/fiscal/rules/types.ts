import type { RoleAssignment } from '@/lib/navigation'

/**
 * The web side of governing the tax rules (Phase 88, ADR 0074). Fiscal decides who may ask
 * and who may approve; this only chooses which buttons to show.
 */

export type RuleSummary = {
  id: string
  ruleKey: string
  version: number
  group: 'legacy' | 'ibsCbs'
  code: string
  precedence: string
  priority: number
  model: string
  environment: string
  purpose: string
  scope: Record<string, string>
  effectiveFrom: string
  effectiveTo: string | null
  rate: { numerator: string; denominator: string }
  formula: string
  expression: unknown
  sourceLocator: string
  definitionDigest: string
}

export type CatalogPackage = {
  id: string
  authority: string
  sourceUri: string
  packageDigest: string
  publishedAt: string
  effectiveFrom: string
  publisher: string
  ruleCount: number
  referenceCount: number
  components: string[]
  adoption: {
    state: 'adopted' | 'withdrawn' | 'never'
    effectiveFrom: string | null
    decidedAt: string | null
  }
  pendingChangeId: string | null
}

export type WorkspaceRule = RuleSummary & { packageId: string; approved: boolean; active: boolean }

export type DiffCounts = { added: number; ended: number; changed: number; unchanged: number }

export type RuleDiff = {
  against: { kind: 'workspace' } | { kind: 'package'; packageId: string }
  entries: {
    ruleKey: string
    change: 'added' | 'ended' | 'changed' | 'unchanged'
    before: RuleSummary | null
    after: RuleSummary | null
    fields: { field: string; before: unknown; after: unknown }[]
  }[]
  counts: DiffCounts
}

export type RuleImpact = {
  months: number
  from: string
  to: string
  examined: number
  truncated: boolean
  unchanged: number
  changed: {
    documentId: string
    issueDate: string
    model: string
    components: { code: string; before: string; after: string; difference: string }[]
  }[]
  unsupported: { documentId: string; issueDate: string; code: string; detail: string }[]
  digest: string
}

export const CHANGE_KINDS = [
  'adopt-package',
  'withdraw-package',
  'add-rule',
  'retire-rule',
] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

export type RuleChange = {
  id: string
  kind: ChangeKind
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  request: Record<string, unknown>
  requestDigest: string
  requestedBy: string
  requestedAt: string
  diff: RuleDiff
  impact: RuleImpact
  decision: {
    outcome: 'approved' | 'rejected' | 'cancelled'
    decidedBy: string
    onBehalfOf: string | null
    delegationId: string | null
    decidedAt: string
    reason: string | null
    resultId: string | null
  } | null
}

export type RuleChangeEntry = Omit<RuleChange, 'diff' | 'impact'> & {
  counts: DiffCounts
  changedDocuments: number
  unsupportedDocuments: number
}

export type SupportRow = {
  id: string
  model: string
  environment: string
  from: string
  until: string
  taxes: string[]
  dimensions: Record<string, unknown>
  evidence: { kind: string; reference?: string; digest?: string }
}

export type RulesData = {
  packages: CatalogPackage[]
  rules: WorkspaceRule[]
  changes: RuleChangeEntry[]
  matrix: SupportRow[]
}

export type RuleAbilities = {
  /** A Fiscal admin asks for changes. */
  canRequest: boolean
  /** A Fiscal admin decides; a delegate may too, which only Fiscal knows, so it is offered. */
  canDecide: boolean
}

export function ruleAbilitiesOf(roles: readonly RoleAssignment[]): RuleAbilities {
  const fiscal = roles.filter((assignment) => assignment.module === 'fiscal')
  const admin = fiscal.some((assignment) => assignment.role === 'admin')
  return {
    canRequest: admin,
    canDecide: fiscal.some((assignment) => assignment.role !== 'auditor'),
  }
}

/** Whether this person may act on a pending change: never on their own request (ADR 0062). */
export function changeActions(
  change: Pick<RuleChange, 'status' | 'requestedBy'>,
  abilities: RuleAbilities,
  personId: string | null,
): { decide: boolean; cancel: boolean } {
  const pending = change.status === 'pending'
  const own = personId !== null && change.requestedBy === personId
  return {
    decide: pending && abilities.canDecide && !own,
    cancel: pending && abilities.canRequest && own,
  }
}

/** A rate as a percentage with up to four decimals, from its exact fraction. */
export function percentOf(rate: { numerator: string; denominator: string }): string {
  const scaled = (BigInt(rate.numerator) * 1_000_000n) / BigInt(rate.denominator)
  const negative = scaled < 0n
  const digits = (negative ? -scaled : scaled).toString().padStart(5, '0')
  const whole = digits.slice(0, -4)
  const fraction = digits.slice(-4).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `,${fraction}` : ''}%`
}
