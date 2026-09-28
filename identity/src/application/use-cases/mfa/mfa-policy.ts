import { type Either, left, right } from '@/core/either'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { Actor } from '@/domain/audit/audit-entry'
import {
  enrollBy,
  isValidGraceDays,
  MFA_POLICIES,
  type MfaPolicy,
  type MfaPolicyKind,
} from '@/domain/mfa/mfa-policy'
import type { Clock } from '../../ports/clock'
import type { MfaPolicies } from '../../ports/mfa'
import type { UnitOfWork } from '../../ports/unit-of-work'

export interface PolicyView {
  readonly policy: MfaPolicyKind
  readonly graceDays: number
  readonly changedAt: Date | null
  readonly enrollBy: Date | null
}

const viewOf = (policy: MfaPolicy): PolicyView => ({ ...policy, enrollBy: enrollBy(policy) })

/** The workspace MFA policy (ADR 0061 §3): off, admins or everyone, with a grace period. */
export class MfaPolicyUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policies: MfaPolicies,
    private readonly clock: Clock,
  ) {}

  async find(tenantId: string): Promise<PolicyView> {
    return viewOf(await this.policies.find(tenantId))
  }

  async change(
    context: { tenantId: string; actor: Actor; requestId: string | null },
    input: { policy: string; graceDays: number },
  ): Promise<Either<InvalidInputError, PolicyView>> {
    if (!(MFA_POLICIES as readonly string[]).includes(input.policy))
      return left(new InvalidInputError('/policy', 'must be off, admins or everyone'))
    if (!isValidGraceDays(input.graceDays))
      return left(new InvalidInputError('/graceDays', 'must be a whole number of days, 0 to 30'))
    const before = await this.policies.find(context.tenantId)
    const now = this.clock.now()
    const next: MfaPolicy = {
      policy: input.policy as MfaPolicyKind,
      graceDays: input.graceDays,
      changedAt: now,
    }
    await this.policies.save(context.tenantId, next)
    await this.unitOfWork.inTenant(context.tenantId, (scope) =>
      scope.audit.append({
        actor: context.actor,
        subjectType: 'workspace',
        subjectId: context.tenantId,
        action: 'workspace.mfa-policy-changed',
        before: { policy: before.policy, graceDays: before.graceDays },
        after: { policy: next.policy, graceDays: next.graceDays },
        requestId: context.requestId,
        occurredAt: now,
      }),
    )
    return right(viewOf(next))
  }
}
