import { type Either, left, right } from '@/core/either'
import { AccountDisabledError } from '@/domain/errors/account-disabled-error'
import { MfaEnrollmentRequiredError } from '@/domain/errors/mfa-errors'
import { TenantSuspendedError } from '@/domain/errors/tenant-suspended-error'
import { WorkspaceSelectionExpiredError } from '@/domain/errors/workspace-selection-expired-error'
import {
  type AuthMethod,
  enrollBy,
  hasSecondFactor,
  type MfaPolicy,
  mfaRequiredFor,
  NO_MFA_POLICY,
} from '@/domain/mfa/mfa-policy'
import { deviceLabel, ipPrefix } from '@/domain/mfa/session-meta'
import type { AccountsRepository } from '@/domain/repositories/accounts-repository'
import type { Clock } from '../ports/clock'
import type { MfaChallenges, MfaPolicies } from '../ports/mfa'
import type { UnitOfWork } from '../ports/unit-of-work'
import type { WorkspaceSelections } from '../ports/workspace-selections'
import type { IssuedSession } from '../services/session-issuer'
import { SessionIssuer } from '../services/session-issuer'
import type { SelectableWorkspace } from './authenticate-account'

export class ListSelectableWorkspacesUseCase {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly selections: WorkspaceSelections,
  ) {}

  async execute(
    token: string,
  ): Promise<Either<WorkspaceSelectionExpiredError, readonly SelectableWorkspace[]>> {
    const accountId = await this.selections.resolve(token)
    if (accountId === null) return left(new WorkspaceSelectionExpiredError())
    const workspaces = await this.accounts.listWorkspaces(accountId)
    return right(workspaces.map(({ tenantId, slug, name }) => ({ tenantId, slug, name })))
  }
}

export class BeginWorkspaceSwitchUseCase {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly selections: WorkspaceSelections,
  ) {}

  async execute(request: { tenantId: string; userId: string }): Promise<
    Either<
      AccountDisabledError,
      {
        selectionToken: string
        selectionExpiresAt: Date
        workspaces: readonly SelectableWorkspace[]
      }
    >
  > {
    const accountId = await this.accounts.findAccountIdByMembership(
      request.tenantId,
      request.userId,
    )
    if (accountId === null)
      return left(new AccountDisabledError('this user is not linked to a global account'))
    const [selection, memberships] = await Promise.all([
      this.selections.issue(accountId),
      this.accounts.listWorkspaces(accountId),
    ])
    return right({
      selectionToken: selection.token,
      selectionExpiresAt: selection.expiresAt,
      workspaces: memberships.map(({ tenantId, slug, name }) => ({ tenantId, slug, name })),
    })
  }
}

/** What the workspace MFA policy needs at sign-in (Phase 67). */
export interface WorkspaceMfaGate {
  readonly policies: MfaPolicies
  readonly challenges: MfaChallenges
}

type SelectFailure =
  | WorkspaceSelectionExpiredError
  | AccountDisabledError
  | TenantSuspendedError
  | MfaEnrollmentRequiredError

export class SelectWorkspaceUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly accounts: AccountsRepository,
    private readonly selections: WorkspaceSelections,
    private readonly sessions: SessionIssuer,
    private readonly clock: Clock,
    private readonly mfa?: WorkspaceMfaGate,
  ) {}

  async execute(request: {
    selectionToken: string
    tenantId: string
    sourceIp?: string | null
    userAgent?: string | null
    requestId?: string | null
  }): Promise<Either<SelectFailure, IssuedSession & { readonly enrollBy?: Date }>> {
    const grant = await this.selections.consumeGrant(request.selectionToken)
    if (grant === null) return left(new WorkspaceSelectionExpiredError())
    const accountId = grant.accountId
    const membership = await this.accounts.findMembership(accountId, request.tenantId)
    if (membership === null) return left(new WorkspaceSelectionExpiredError())
    const policy = this.mfa ? await this.mfa.policies.find(membership.tenantId) : NO_MFA_POLICY

    return this.unitOfWork.inTenant(membership.tenantId, async (scope) => {
      const tenant = await scope.tenants.findById(membership.tenantId)
      if (tenant === null || !tenant.isActive()) return left(new TenantSuspendedError())
      const user = await scope.users.findById(membership.userId)
      if (user === null || !user.canAuthenticate())
        return left(new AccountDisabledError('this workspace membership has been disabled'))

      const now = this.clock.now()
      const deadline = this.enrollmentDeadline(policy, user.claims().roles, grant.amr)
      if (deadline !== null && now.getTime() >= deadline.getTime())
        return left(await this.enrollmentRequired(accountId))
      user.recordSuccessfulLogin(now)
      await scope.users.save(user)
      await scope.audit.append({
        actor: { type: 'user', id: membership.userId },
        subjectType: 'session',
        subjectId: membership.userId,
        action: 'session.opened',
        requestId: request.requestId ?? null,
        sourceIp: request.sourceIp ?? null,
        occurredAt: now,
      })
      const session = await this.sessions.open(user, now, {
        device: deviceLabel(request.userAgent),
        ipPrefix: ipPrefix(request.sourceIp),
        amr: grant.amr as AuthMethod[],
        authTime: grant.authTime ?? now,
      })
      return right(deadline ? { ...session, enrollBy: deadline } : session)
    })
  }

  /** When a person the policy covers must have a second factor by; null when not covered. */
  private enrollmentDeadline(
    policy: MfaPolicy,
    roles: readonly { role: string }[],
    amr: readonly string[],
  ): Date | null {
    if (!this.mfa || !mfaRequiredFor(policy, roles) || hasSecondFactor(amr)) return null
    return enrollBy(policy)
  }

  private async enrollmentRequired(accountId: string): Promise<MfaEnrollmentRequiredError> {
    const enrollment = await (this.mfa as WorkspaceMfaGate).challenges.issue(
      accountId,
      'enrollment',
    )
    return new MfaEnrollmentRequiredError(enrollment.token, enrollment.expiresAt)
  }
}
