import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { TaskDue } from '../events/task-events'
import type { RecordText, Subject } from '../value-objects/record-values'

export type TaskStatus = 'open' | 'completed' | 'cancelled'

/** When a task is due and when to remind its assignee; the reminder is optional. */
export interface TaskSchedule {
  readonly dueAt: Date
  readonly remindAt: Date | null
}

interface TaskProps {
  tenantId: string
  accountId: string
  subject: Subject
  title: RecordText
  assigneeId: string
  dueAt: Date
  remindAt: Date | null
  remindedAt: Date | null
  status: TaskStatus
  createdBy: string
  closedBy: string | null
  closedAt: Date | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface TaskSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly accountId: string
  readonly subject: Subject
  readonly title: string
  readonly assigneeId: string
  readonly dueAt: Date
  readonly remindAt: Date | null
  readonly remindedAt: Date | null
  readonly status: TaskStatus
  readonly createdBy: string
  readonly closedBy: string | null
  readonly closedAt: Date | null
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

type Refusal = Either<ConflictError, void>

function scheduleOf(schedule: TaskSchedule): Either<InvalidInputError, TaskSchedule> {
  if (schedule.remindAt && schedule.remindAt.getTime() > schedule.dueAt.getTime())
    return left(new InvalidInputError('/remindAt', 'must not be later than the due instant'))
  return right(schedule)
}

const sameInstant = (a: Date | null, b: Date | null) =>
  a === null ? b === null : b !== null && a.getTime() === b.getTime()

/**
 * Something a person has to do about an account, by a due instant (Phase 57).
 *
 * A task is completed or cancelled, never deleted. Its reminder is armed while it is open
 * and has a reminder instant that was not sent yet; sending it records the instant, so it
 * is sent once. Rescheduling arms it again, because the assignee now expects a new alert.
 */
export class Task extends AggregateRoot<TaskProps> {
  static create(
    props: TaskSchedule & {
      tenantId: string
      accountId: string
      subject: Subject
      title: RecordText
      assigneeId: string
      createdBy: string
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<InvalidInputError, Task> {
    const schedule = scheduleOf(props)
    if (schedule.isLeft()) return left(schedule.value)
    const { now, ...rest } = props
    return right(
      new Task(
        {
          ...rest,
          remindedAt: null,
          status: 'open',
          closedBy: null,
          closedAt: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        id,
      ),
    )
  }

  static rehydrate(props: TaskProps, id: UniqueEntityID): Task {
    return new Task(props, id)
  }

  get accountId(): string {
    return this.props.accountId
  }

  get status(): TaskStatus {
    return this.props.status
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  /** Change the title or the schedule of an open task; returns whether anything changed. */
  revise(
    change: TaskSchedule & { title: RecordText },
    now: Date,
  ): Either<ConflictError | InvalidInputError, boolean> {
    const open = this.requireOpen()
    if (open.isLeft()) return left(open.value)
    const schedule = scheduleOf(change)
    if (schedule.isLeft()) return left(schedule.value)
    const rescheduled =
      !sameInstant(change.dueAt, this.props.dueAt) ||
      !sameInstant(change.remindAt, this.props.remindAt)
    if (!rescheduled && change.title.equals(this.props.title)) return right(false)
    this.props.title = change.title
    this.props.dueAt = change.dueAt
    this.props.remindAt = change.remindAt
    if (rescheduled) this.props.remindedAt = null
    this.touch(now)
    return right(true)
  }

  reassign(assigneeId: string, now: Date): Refusal {
    const open = this.requireOpen()
    if (open.isLeft()) return open
    if (assigneeId === this.props.assigneeId)
      return left(new ConflictError('the task is already assigned to this user'))
    this.props.assigneeId = assigneeId
    this.touch(now)
    return right(undefined)
  }

  complete(actor: string, now: Date): Refusal {
    return this.close('completed', actor, now)
  }

  cancel(actor: string, now: Date): Refusal {
    return this.close('cancelled', actor, now)
  }

  /** Whether the reminder should be sent at `now`: armed and its instant has come. */
  isReminderDue(now: Date): boolean {
    return (
      this.props.status === 'open' &&
      this.props.remindAt !== null &&
      this.props.remindedAt === null &&
      this.props.remindAt.getTime() <= now.getTime()
    )
  }

  /** Send the reminder: once per armed reminder, published as `crm.task.due`. */
  sendReminder(now: Date): Refusal {
    if (!this.isReminderDue(now) || this.props.remindAt === null)
      return left(new ConflictError('the task has no reminder due'))
    this.props.remindedAt = now
    this.touch(now)
    this.addDomainEvent(
      new TaskDue(this.id, this.props.tenantId, now, {
        accountId: this.props.accountId,
        subject: this.props.subject,
        assigneeId: this.props.assigneeId,
        dueAt: this.props.dueAt,
        remindAt: this.props.remindAt,
      }),
    )
    return right(undefined)
  }

  isOverdue(now: Date): boolean {
    return this.props.status === 'open' && this.props.dueAt.getTime() < now.getTime()
  }

  toSnapshot(): Readonly<TaskSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      accountId: this.props.accountId,
      subject: this.props.subject,
      title: this.props.title.value,
      assigneeId: this.props.assigneeId,
      dueAt: this.props.dueAt,
      remindAt: this.props.remindAt,
      remindedAt: this.props.remindedAt,
      status: this.props.status,
      createdBy: this.props.createdBy,
      closedBy: this.props.closedBy,
      closedAt: this.props.closedAt,
      version: this.props.version,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }

  private close(status: 'completed' | 'cancelled', actor: string, now: Date): Refusal {
    const open = this.requireOpen()
    if (open.isLeft()) return open
    this.props.status = status
    this.props.closedBy = actor
    this.props.closedAt = now
    this.touch(now)
    return right(undefined)
  }

  private requireOpen(): Refusal {
    return this.props.status === 'open'
      ? right(undefined)
      : left(new ConflictError(`the task is ${this.props.status}`))
  }

  private touch(now: Date): void {
    this.props.version += 1
    this.props.updatedAt = now
  }
}
