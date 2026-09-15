import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Actor } from '@/domain/audit/audit-entry'
import type { AccountsRepository } from '@/domain/repositories/accounts-repository'
import { Locale } from '@/domain/value-objects/locale'
import type { Clock } from '../ports/clock'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface ChoosePreferredLocaleRequest {
  readonly tenantId: string
  readonly userId: string
  readonly locale: string
  readonly actor: Actor
  readonly requestId?: string | null
}

export type ChoosePreferredLocaleResponse = Either<
  InvalidInputError | ResourceNotFoundError,
  { readonly preferredLocale: string }
>

/**
 * Record the language someone reads in.
 *
 * The choice lands on the global account, not on the workspace membership that happened
 * to be open when it was made: the same person switching workspaces keeps their language,
 * and a workspace does not impose one on its members (ADR 0038, ADR 0044).
 */
@Injectable()
export class ChoosePreferredLocaleUseCase {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: ChoosePreferredLocaleRequest): Promise<ChoosePreferredLocaleResponse> {
    const locale = Locale.create(request.locale)
    if (locale.isLeft()) return left(locale.value)

    const accountId = await this.accounts.findAccountIdByMembership(
      request.tenantId,
      request.userId,
    )
    if (accountId === null) return left(new ResourceNotFoundError('account'))

    const account = await this.accounts.findById(accountId)
    if (account === null) return left(new ResourceNotFoundError('account'))

    const now = this.clock.now()
    account.choosePreferredLocale(locale.value, now)
    await this.accounts.save(account)

    await this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      await scope.audit.append({
        actor: request.actor,
        subjectType: 'account',
        subjectId: accountId,
        action: 'account.locale.chosen',
        dataSubjectId: request.userId,
        requestId: request.requestId ?? null,
        occurredAt: now,
      })
    })

    return right({ preferredLocale: locale.value.value })
  }
}
