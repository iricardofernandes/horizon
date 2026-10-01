import type { RoleAssignment } from './navigation'
import { reportingAbilitiesOf } from './reports'

/**
 * The web side of the controls screen (Phase 70): delegations, approval thresholds and the
 * consistency runs. Each module decides; this only chooses whom to ask and shapes answers.
 */

/**
 * The approvals each module may lend: the deciding side of its segregation-of-duties pairs
 * (ADR 0062). A copy of the contracts' matrix, which the web does not import; each module
 * refuses a permission it does not declare.
 */
export const DELEGABLE: Readonly<Record<DelegatingModule, readonly string[]>> = {
  financial: ['financial:payable:approve'],
  procurement: ['procurement:requisition:approve', 'procurement:order:approve'],
  inventory: ['inventory:adjustment:approve', 'inventory:count:approve'],
  ledger: ['ledger:entry:approve'],
  treasury: ['treasury:transfer:approve'],
  fiscal: ['fiscal:rules:approve'],
}

export type DelegatingModule =
  | 'financial'
  | 'procurement'
  | 'inventory'
  | 'ledger'
  | 'treasury'
  | 'fiscal'
export const DELEGATING_MODULES = Object.keys(DELEGABLE) as DelegatingModule[]

/** Modules whose approval threshold the screen shows and, for their admins, sets. */
export const THRESHOLD_MODULES = ['ledger', 'treasury'] as const
export type ThresholdModule = (typeof THRESHOLD_MODULES)[number]

/** Roles that read but never decide: they see delegations, and lend nothing. */
const READ_ONLY_ROLES = new Set(['viewer', 'auditor'])

/** Where only some roles decide: in Fiscal, only an admin approves a rule change (Phase 88). */
const LENDING_ROLES: Partial<Record<DelegatingModule, ReadonlySet<string>>> = {
  fiscal: new Set(['admin']),
}

export type Delegation = {
  id: string
  permission: string
  delegatorId: string
  delegateId: string
  startsAt: string
  endsAt: string
  reason: string | null
  status: 'scheduled' | 'active' | 'ended' | 'revoked'
  createdAt: string
  revokedAt: string | null
  revokedBy: string | null
}

export type ApprovalPolicy = { currency: string; threshold: string; updatedAt: string }

export type ConsistencyCheck = {
  check: string
  outcome: 'matched' | 'differences' | 'not-applicable' | 'unread'
  compared: number
  differences: { key: string; owner: string; ledger: string }[]
  reason: string | null
}

export type ConsistencyRun = {
  runId: string
  trigger: 'scheduled' | 'manual'
  outcome: 'consistent' | 'inconsistent' | 'incomplete'
  checks: ConsistencyCheck[]
  pendingPostings: number
  startedBy: string
  startedAt: string
  finishedAt: string
}

function rolesIn(roles: readonly RoleAssignment[], module: string): string[] {
  return roles.filter((assignment) => assignment.module === module).map((entry) => entry.role)
}

/** The modules whose delegations the person may read: any role in them. */
export function delegationModulesOf(roles: readonly RoleAssignment[]): DelegatingModule[] {
  return DELEGATING_MODULES.filter((module) => rolesIn(roles, module).length > 0)
}

/** The modules where the person may lend an approval: a role that decides something. */
export function lendingModulesOf(roles: readonly RoleAssignment[]): DelegatingModule[] {
  return DELEGATING_MODULES.filter((module) =>
    rolesIn(roles, module).some((role) =>
      LENDING_ROLES[module] ? LENDING_ROLES[module].has(role) : !READ_ONLY_ROLES.has(role),
    ),
  )
}

export function readsThresholds(roles: readonly RoleAssignment[]): ThresholdModule[] {
  return THRESHOLD_MODULES.filter((module) => rolesIn(roles, module).length > 0)
}

export function setsThresholds(roles: readonly RoleAssignment[]): ThresholdModule[] {
  return THRESHOLD_MODULES.filter((module) => rolesIn(roles, module).includes('admin'))
}

/** Reporting runs the consistency checks: its readers see them, whoever reconciles starts one. */
export function consistencyAccessOf(roles: readonly RoleAssignment[]) {
  const abilities = reportingAbilitiesOf(roles)
  return { read: abilities.read, run: abilities.reconcile }
}

/**
 * A delegation's period as the API wants it: the whole days typed, from the start of the
 * first to the end of the last, in UTC. Null when the end comes before the start.
 */
export function periodOf(from: string, to: string): { startsAt: string; endsAt: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null
  if (to < from) return null
  return { startsAt: `${from}T00:00:00.000Z`, endsAt: `${to}T23:59:59.999Z` }
}

/** Live delegations first, then the rest; newest first inside each. */
export function sortDelegations(delegations: readonly Delegation[]): Delegation[] {
  const rank = { active: 0, scheduled: 1, ended: 2, revoked: 3 } as const
  return [...delegations].sort(
    (left, right) =>
      rank[left.status] - rank[right.status] || right.createdAt.localeCompare(left.createdAt),
  )
}

/** Only a delegation that is still to come or running can be revoked. */
export function revocable(delegation: Delegation): boolean {
  return delegation.status === 'active' || delegation.status === 'scheduled'
}

/**
 * A threshold typed in the currency's major unit, as minor units. Takes `1.000,00`, `1,000.00`,
 * `1000,5` or `1000`: the last separator followed by one or two digits marks the decimals, and
 * the others group thousands. Null for anything else.
 */
export function minorUnitsOf(typed: string): string | null {
  const value = typed.replace(/\s/g, '')
  const match = /^(\d{1,3}(?:([.,])\d{3})*|\d+)(?:([.,])(\d{1,2}))?$/.exec(value)
  if (!match) return null
  const [, whole = '', grouping, decimal, cents = ''] = match
  if (grouping && decimal === grouping) return null
  const digits = whole.replace(/[.,]/g, '')
  return (BigInt(digits) * 100n + BigInt(cents.padEnd(2, '0'))).toString()
}

/** The checks of a run that need a person to look: differences, or a source that did not answer. */
export function attentionOf(run: ConsistencyRun): ConsistencyCheck[] {
  return run.checks.filter((check) => check.outcome === 'differences' || check.outcome === 'unread')
}
