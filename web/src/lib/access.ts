/**
 * The web side of access hardening (ADR 0061, Phase 67): what a refusal means, and how codes
 * and sessions read. Identity decides everything; this only shapes it for the screens.
 */

export const STEP_UP_REQUIRED = 'https://horizon.dev/problems/step-up-required'
export const MFA_LOCKED = 'https://horizon.dev/problems/mfa-locked'

export type SecondFactorMethod = 'totp' | 'recovery' | 'passkey'

export type FactorView = {
  id: string
  kind: 'totp' | 'passkey'
  label: string
  active: boolean
  createdAt: string
  lastUsedAt: string | null
}

export type SessionView = {
  id: string
  device: string
  ipPrefix: string | null
  secondFactor: boolean
  createdAt: string
  lastUsedAt: string
  current: boolean
}

export type InvitationView = {
  id: string
  email: string
  name: string
  roles: { module: string; role: string }[]
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  createdAt: string
  expiresAt: string
  sends: number
}

/** The problem type of an API refusal, when it has one. */
export function problemTypeOf(body: unknown): string | null {
  const type = (body as { type?: unknown } | null)?.type
  return typeof type === 'string' ? type : null
}

export function isStepUpRequired(status: number, body: unknown): boolean {
  return status === 403 && problemTypeOf(body) === STEP_UP_REQUIRED
}

/** A code as typed: TOTP keeps its six digits, a recovery code its letters and dash. */
export function cleanCode(method: 'totp' | 'recovery', value: string): string {
  return method === 'totp' ? value.replace(/\D/g, '').slice(0, 6) : value.trim().toLowerCase()
}

/** The recovery codes as one text a person can save or print. */
export function recoveryCodesText(codes: readonly string[], workspace: string): string {
  return [`Horizon — ${workspace}`, '', ...codes, ''].join('\n')
}

/** The secret grouped by four, easier to type into an app than to read in one run. */
export function groupedSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim()
}

export function invitationTokenOf(search: string): string | null {
  const token = new URLSearchParams(search).get('token')
  return token && /^[A-Za-z0-9_-]{20,100}$/.test(token) ? token : null
}
