import { type Either, left, right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { Task, type TaskSchedule } from '@/domain/entities/task'
import { instantOf, RecordText } from '@/domain/value-objects/record-values'
import type { Clock } from '../ports/clock'
import type { CrmScope, CrmUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext, type IdempotentContext, once } from './commands'
import { activeOwner } from './manage-opportunities'
import { accountOfSubject, type Failure, liveAccount, type SubjectInput } from './record-subjects'

export interface TaskInput {
  readonly title: string
  readonly dueAt: string
  readonly remindAt?: string | null | undefined
}

interface TaskTerms extends TaskSchedule {
  readonly title: RecordText
}

function termsOf(input: TaskInput): Either<InvalidInputError, TaskTerms> {
  const title = RecordText.line(input.title, '/title')
  if (title.isLeft()) return left(title.value)
  const dueAt = instantOf(input.dueAt, '/dueAt')
  if (dueAt.isLeft()) return left(dueAt.value)
  const remindAt: Either<InvalidInputError, Date | null> = input.remindAt
    ? instantOf(input.remindAt, '/remindAt')
    : right(null)
  if (remindAt.isLeft()) return left(remindAt.value)
  return right({ title: title.value, dueAt: dueAt.value, remindAt: remindAt.value })
}

/** Give someone a task about an account. Retried with the same key, it creates it once. */
export class CreateTaskUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly context: IdempotentContext
    readonly subject: SubjectInput
    readonly assigneeId: string
    readonly task: TaskInput
  }): Promise<Either<Failure, { taskId: string }>> {
    const terms = termsOf(request.task)
    if (terms.isLeft()) return left(terms.value)
    const { context } = request
    const { context: _, ...asked } = request
    return once(this.unitOfWork, context, 'task.create', asked, async (scope) => {
      const target = await accountOfSubject(scope, request.subject)
      if (target.isLeft()) return left(target.value)
      const refused = await activeOwner(scope, request.assigneeId)
      if (refused) return left(refused)
      const now = this.clock.now()
      const accountId = target.value.account.id.toString()
      const task = Task.create({
        ...terms.value,
        tenantId: context.tenantId,
        accountId,
        subject: target.value.subject,
        assigneeId: request.assigneeId,
        createdBy: context.actor,
        now,
      })
      if (task.isLeft()) return left(task.value)
      await scope.tasks.create(task.value)
      const taskId = task.value.id.toString()
      await audit(scope, context, {
        action: 'task.created',
        subjectType: 'task',
        subjectId: taskId,
        occurredAt: now,
        details: { accountId, subject: target.value.subject, assigneeId: request.assigneeId },
      })
      return right({ taskId })
    })
  }
}

type Decision<T> = Either<ConflictError | InvalidInputError | ResourceNotFoundError, T>

export class ChangeTaskUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  revise(request: {
    readonly context: CommandContext
    readonly taskId: string
    readonly task: TaskInput
  }): Promise<Either<Failure, boolean>> {
    const terms = termsOf(request.task)
    if (terms.isLeft()) return Promise.resolve(left(terms.value))
    return this.run(request, 'task.revised', async (task, _scope, now) =>
      task.revise(terms.value, now),
    )
  }

  reassign(request: {
    readonly context: CommandContext
    readonly taskId: string
    readonly assigneeId: string
  }) {
    return this.run(
      request,
      'task.reassigned',
      async (task, scope, now) => {
        const refused = await activeOwner(scope, request.assigneeId)
        if (refused) return left(refused)
        return task.reassign(request.assigneeId, now)
      },
      { assigneeId: request.assigneeId },
    )
  }

  complete(request: { readonly context: CommandContext; readonly taskId: string }) {
    return this.run(request, 'task.completed', async (task, _scope, now) =>
      task.complete(request.context.actor, now),
    )
  }

  cancel(request: { readonly context: CommandContext; readonly taskId: string }) {
    return this.run(request, 'task.cancelled', async (task, _scope, now) =>
      task.cancel(request.context.actor, now),
    )
  }

  /** Load, decide, save and audit one task; a decision that changed nothing records nothing. */
  private run<T>(
    request: { readonly context: CommandContext; readonly taskId: string },
    action: string,
    decide: (task: Task, scope: CrmScope, now: Date) => Promise<Decision<T>>,
    details: Readonly<Record<string, unknown>> = {},
  ): Promise<Either<Failure, T>> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const task = await scope.tasks.findById(request.taskId)
      if (!task) return left(new ResourceNotFoundError('task was not found'))
      const account = await liveAccount(scope, task.accountId)
      if (account.isLeft()) return left(account.value)
      const now = this.clock.now()
      const outcome = await decide(task, scope, now)
      if (outcome.isLeft() || outcome.value === false) return outcome
      await scope.tasks.save(task)
      await audit(scope, context, {
        action,
        subjectType: 'task',
        subjectId: request.taskId,
        occurredAt: now,
        details,
      })
      return outcome
    })
  }
}
