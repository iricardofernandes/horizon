import type { RoleAssignment } from '@/domain/value-objects/role-assignments'

export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

/**
 * An invitation to join a workspace with roles (ADR 0061 §1). Only a digest of its token is
 * kept, and its email only while it is pending: afterwards only the masked form remains.
 */
export interface Invitation {
  readonly id: string
  readonly tenantId: string
  readonly email: string | null
  readonly maskedEmail: string
  readonly name: string
  readonly roles: readonly RoleAssignment[]
  readonly tokenDigest: string
  readonly status: InvitationStatus
  readonly invitedBy: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly sends: number
  readonly acceptedUserId: string | null
  readonly endedAt: Date | null
}

/** `ana.souza@empresa.com.br` → `a***@empresa.com.br`. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  return `${local.slice(0, 1)}***@${domain}`
}

export function statusAt(invitation: Invitation, now: Date): InvitationStatus {
  if (invitation.status === 'pending' && invitation.expiresAt.getTime() <= now.getTime())
    return 'expired'
  return invitation.status
}

export function isUsable(invitation: Invitation, now: Date): boolean {
  return statusAt(invitation, now) === 'pending'
}

/** A new link and a new 72 hours; the old link stops working. */
export function resent(invitation: Invitation, tokenDigest: string, now: Date): Invitation {
  return {
    ...invitation,
    tokenDigest,
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    sends: invitation.sends + 1,
  }
}

/** Ended, one way or another: the email goes, the masked form stays. */
export function ended(
  invitation: Invitation,
  status: 'accepted' | 'revoked' | 'expired',
  now: Date,
  acceptedUserId: string | null = null,
): Invitation {
  return { ...invitation, status, email: null, endedAt: now, acceptedUserId }
}
