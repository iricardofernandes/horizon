export const MFA_POLICIES = ['off', 'admins', 'everyone'] as const
export type MfaPolicyKind = (typeof MFA_POLICIES)[number]

export interface MfaPolicy {
  readonly policy: MfaPolicyKind
  readonly graceDays: number
  /** When the policy last changed; the grace period counts from here. */
  readonly changedAt: Date | null
}

export const NO_MFA_POLICY: MfaPolicy = { policy: 'off', graceDays: 0, changedAt: null }

const DAY_MS = 86_400_000

/** Whether the workspace asks this person for a second factor (ADR 0061 §3). */
export function mfaRequiredFor(
  policy: MfaPolicy,
  roles: readonly { readonly role: string }[],
): boolean {
  if (policy.policy === 'everyone') return true
  if (policy.policy === 'admins')
    return roles.some((assignment) => assignment.role === 'admin' || assignment.role === 'owner')
  return false
}

/** Until when someone the policy covers may still sign in without a second factor. */
export function enrollBy(policy: MfaPolicy): Date | null {
  if (policy.policy === 'off' || policy.changedAt === null) return null
  return new Date(policy.changedAt.getTime() + policy.graceDays * DAY_MS)
}

export function isValidGraceDays(days: number): boolean {
  return Number.isInteger(days) && days >= 0 && days <= 30
}

/** Methods of authentication, as the `amr` claim names them (RFC 8176). */
export type AuthMethod = 'pwd' | 'otp' | 'hwk' | 'rec'

export function hasSecondFactor(amr: readonly string[]): boolean {
  return amr.some((method) => method === 'otp' || method === 'hwk' || method === 'rec')
}
