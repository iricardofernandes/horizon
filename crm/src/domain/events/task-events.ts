import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import type { Subject } from '../value-objects/record-values'

/**
 * `crm.task.due` v1: a task's reminder came due (Phase 57). Its title is free text that
 * may name a person, so it never leaves CRM.
 */
export class TaskDue implements DomainEvent {
  readonly eventType = 'crm.task.due'
  readonly eventVersion = 1

  constructor(
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    readonly occurredAt: Date,
    private readonly task: {
      readonly accountId: string
      readonly subject: Subject
      readonly assigneeId: string
      readonly dueAt: Date
      readonly remindAt: Date
    },
  ) {}

  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      taskId: this.aggregateId.toString(),
      accountId: this.task.accountId,
      subject: { type: this.task.subject.type, id: this.task.subject.id },
      assigneeId: this.task.assigneeId,
      dueAt: this.task.dueAt.toISOString(),
      remindAt: this.task.remindAt.toISOString(),
    }
  }
}
