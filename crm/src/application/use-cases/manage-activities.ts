import { type Either, left, right } from '@/core/either'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { Activity, type ActivityDetails } from '@/domain/entities/activity'
import {
  activityKindOf,
  instantOf,
  MAX_SUMMARY,
  RecordText,
} from '@/domain/value-objects/record-values'
import type { Clock } from '../ports/clock'
import type { CrmUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext, type IdempotentContext, once } from './commands'
import { contactsOf } from './manage-opportunities'
import { accountOfSubject, type Failure, liveAccount, type SubjectInput } from './record-subjects'

export interface ActivityInput {
  readonly kind: string
  readonly occurredAt: string
  readonly title: string
  readonly summary?: string | null | undefined
  readonly contactIds?: readonly string[] | undefined
}

/** A little slack for the caller's clock; an activity is something that already happened. */
const CLOCK_SKEW_MS = 5 * 60_000

function detailsOf(input: ActivityInput, now: Date): Either<InvalidInputError, ActivityDetails> {
  const kind = activityKindOf(input.kind)
  if (kind.isLeft()) return left(kind.value)
  const occurredAt = instantOf(input.occurredAt, '/occurredAt')
  if (occurredAt.isLeft()) return left(occurredAt.value)
  if (occurredAt.value.getTime() > now.getTime() + CLOCK_SKEW_MS)
    return left(
      new InvalidInputError('/occurredAt', 'an activity is recorded after it happens; plan a task'),
    )
  const title = RecordText.line(input.title, '/title')
  if (title.isLeft()) return left(title.value)
  const summary: Either<InvalidInputError, RecordText | null> = input.summary?.trim()
    ? RecordText.long(input.summary, '/summary', MAX_SUMMARY)
    : right(null)
  if (summary.isLeft()) return left(summary.value)
  return right({
    kind: kind.value,
    occurredAt: occurredAt.value,
    title: title.value,
    summary: summary.value,
    contactIds: [...new Set(input.contactIds ?? [])],
  })
}

/** Record a call, meeting, email or visit. Retried with the same key, it records it once. */
export class RecordActivityUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly context: IdempotentContext
    readonly subject: SubjectInput
    readonly activity: ActivityInput
  }): Promise<Either<Failure, { activityId: string }>> {
    const now = this.clock.now()
    const details = detailsOf(request.activity, now)
    if (details.isLeft()) return left(details.value)
    const { context } = request
    const { context: _, ...asked } = request
    return once(this.unitOfWork, context, 'activity.record', asked, async (scope) => {
      const target = await accountOfSubject(scope, request.subject)
      if (target.isLeft()) return left(target.value)
      const accountId = target.value.account.id.toString()
      const refused = await contactsOf(scope, accountId, details.value.contactIds)
      if (refused) return left(refused)
      const activity = Activity.record({
        ...details.value,
        tenantId: context.tenantId,
        accountId,
        subject: target.value.subject,
        recordedBy: context.actor,
        now,
      })
      await scope.activities.create(activity)
      const activityId = activity.id.toString()
      await audit(scope, context, {
        action: 'activity.recorded',
        subjectType: 'activity',
        subjectId: activityId,
        occurredAt: now,
        details: { accountId, subject: target.value.subject, kind: details.value.kind },
      })
      return right({ activityId })
    })
  }
}

/** Correct what was recorded. The audit names the fields that changed, never their text. */
export class ReviseActivityUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly context: CommandContext
    readonly activityId: string
    readonly activity: ActivityInput
  }): Promise<Either<Failure, { revised: boolean }>> {
    const now = this.clock.now()
    const details = detailsOf(request.activity, now)
    if (details.isLeft()) return left(details.value)
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const activity = await scope.activities.findById(request.activityId)
      if (!activity) return left(new ResourceNotFoundError('activity was not found'))
      const account = await liveAccount(scope, activity.accountId)
      if (account.isLeft()) return left(account.value)
      const refused = await contactsOf(scope, activity.accountId, details.value.contactIds)
      if (refused) return left(refused)
      const changed = activity.revise(details.value, now)
      if (!changed.length) return right({ revised: false })
      await scope.activities.save(activity)
      await audit(scope, context, {
        action: 'activity.revised',
        subjectType: 'activity',
        subjectId: request.activityId,
        occurredAt: now,
        details: { changed },
      })
      return right({ revised: true })
    })
  }
}
