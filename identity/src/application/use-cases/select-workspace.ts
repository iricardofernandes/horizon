import { type Either, left, right } from '@/core/either'
import { AccountDisabledError } from '@/domain/errors/account-disabled-error'
import { TenantSuspendedError } from '@/domain/errors/tenant-suspended-error'
import { WorkspaceSelectionExpiredError } from '@/domain/errors/workspace-selection-expired-error'
import type { AccountsRepository } from '@/domain/repositories/accounts-repository'
import type { Clock } from '../ports/clock'
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

export class SelectWorkspaceUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly accounts: AccountsRepository,
    private readonly selections: WorkspaceSelections,
    private readonly sessions: SessionIssuer,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    selectionToken: string
    tenantId: string
    sourceIp?: string | null
    requestId?: string | null
  }): Promise<
    Either<
      WorkspaceSelectionExpiredError | AccountDisabledError | TenantSuspendedError,
      IssuedSession
    >
  > {
    const accountId = await this.selections.consume(request.selectionToken)
    if (accountId === null) return left(new WorkspaceSelectionExpiredError())
    const membership = await this.accounts.findMembership(accountId, request.tenantId)
    if (membership === null) return left(new WorkspaceSelectionExpiredError())

    return this.unitOfWork.inTenant(membership.tenantId, async (scope) => {
      const tenant = await scope.tenants.findById(membership.tenantId)
      if (tenant === null || !tenant.isActive()) return left(new TenantSuspendedError())
      const user = await scope.users.findById(membership.userId)
      if (user === null || !user.canAuthenticate())
        return left(new AccountDisabledError('this workspace membership has been disabled'))

      const now = this.clock.now()
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
      return right(await this.sessions.open(user, now))
    })
  }
}
