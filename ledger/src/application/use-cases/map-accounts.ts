import { left, right } from '@/core/either'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { AccountMapping, type PostingRole } from '@/domain/entities/account-mapping'
import type { Clock } from '../ports/clock'
import type { LedgerUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext, type Outcome } from './commands'

/**
 * Say which of the workspace's accounts plays one part in the automatic postings.
 *
 * Pointing a role at another account changes what is posted next, never what was posted
 * before: the transactions already written name their accounts and are immutable.
 */
export class DefineAccountMappingUseCase {
  constructor(
    private readonly unitOfWork: LedgerUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    role: PostingRole
    key: string | null
    accountId: string
  }): Outcome<{ id: string; role: PostingRole; accountCode: string }> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const account = await scope.accounts.findById(request.accountId)
      if (!account) return left(new ResourceNotFoundError('account was not found'))
      const now = this.clock.now()
      const existing = await scope.mappings.find(request.role, request.key)
      let defined: AccountMapping
      if (existing) {
        const pointed = existing.pointAt(account, context.actor, now)
        if (pointed.isLeft()) return left(pointed.value)
        defined = existing
      } else {
        const created = AccountMapping.define({
          tenantId: context.tenantId,
          role: request.role,
          key: request.key,
          account,
          actor: context.actor,
          now,
        })
        if (created.isLeft()) return left(created.value)
        defined = created.value
      }
      await scope.mappings.save(defined)
      await audit(scope, context, {
        action: 'mapping.defined',
        subjectType: 'mapping',
        subjectId: defined.id.toString(),
        occurredAt: now,
        details: {
          role: defined.role,
          key: defined.key,
          accountId: defined.accountId,
          accountCode: defined.accountCode,
        },
      })
      return right({ id: defined.id.toString(), role: request.role, accountCode: account.code })
    })
  }
}
