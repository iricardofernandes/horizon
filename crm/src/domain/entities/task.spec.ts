import { randomUUID } from 'node:crypto'
import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { RecordText } from '../value-objects/record-values'
import { Task } from './task'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const at = (iso: string) => new Date(iso)
const title = (value = 'Ligar para o comprador') => valid(RecordText.line(value, '/title'))
const accountId = randomUUID()

function task(schedule: { dueAt: Date; remindAt: Date | null }) {
  return valid(
    Task.create({
      tenantId: randomUUID(),
      accountId,
      subject: { type: 'account', id: accountId },
      title: title(),
      assigneeId: randomUUID(),
      createdBy: 'ana',
      now: at('2026-09-27T12:00:00Z'),
      ...schedule,
    }),
  )
}

describe('task', () => {
  it('refuses a reminder after the due instant', () => {
    const refused = Task.create({
      tenantId: randomUUID(),
      accountId,
      subject: { type: 'account', id: accountId },
      title: title(),
      assigneeId: randomUUID(),
      createdBy: 'ana',
      now: at('2026-09-27T12:00:00Z'),
      dueAt: at('2026-09-28T12:00:00Z'),
      remindAt: at('2026-09-28T12:00:01Z'),
    })
    expect(refused.isLeft() && refused.value.message).toMatch(/not be later/)
  })

  it('sends its reminder once, when its instant has come, and publishes no title', () => {
    const subject = task({
      dueAt: at('2026-09-28T12:00:00Z'),
      remindAt: at('2026-09-28T11:30:00Z'),
    })
    expect(subject.sendReminder(at('2026-09-28T11:29:59Z')).isLeft()).toBe(true)
    expect(subject.sendReminder(at('2026-09-28T11:30:00Z')).isRight()).toBe(true)
    expect(subject.sendReminder(at('2026-09-28T11:31:00Z')).isLeft()).toBe(true)
    const [event, ...more] = subject.pullDomainEvents()
    expect(more).toEqual([])
    expect(event?.eventType).toBe('crm.task.due')
    expect(event?.payloadOf()).toEqual({
      taskId: subject.id.toString(),
      accountId,
      subject: { type: 'account', id: accountId },
      assigneeId: snapshotOf(subject).assigneeId,
      dueAt: '2026-09-28T12:00:00.000Z',
      remindAt: '2026-09-28T11:30:00.000Z',
    })
    expect(snapshotOf(subject).remindedAt).toEqual(at('2026-09-28T11:30:00Z'))
  })

  it('arms the reminder again when it is rescheduled, but not for a new title', () => {
    const subject = task({
      dueAt: at('2026-09-28T12:00:00Z'),
      remindAt: at('2026-09-28T11:00:00Z'),
    })
    valid(subject.sendReminder(at('2026-09-28T11:00:00Z')))
    expect(
      valid(
        subject.revise(
          {
            title: title('Ligar de novo'),
            dueAt: at('2026-09-28T12:00:00Z'),
            remindAt: at('2026-09-28T11:00:00Z'),
          },
          at('2026-09-28T11:05:00Z'),
        ),
      ),
    ).toBe(true)
    expect(subject.isReminderDue(at('2026-09-28T11:10:00Z'))).toBe(false)
    valid(
      subject.revise(
        {
          title: title('Ligar de novo'),
          dueAt: at('2026-09-29T12:00:00Z'),
          remindAt: at('2026-09-29T11:00:00Z'),
        },
        at('2026-09-28T11:06:00Z'),
      ),
    )
    expect(snapshotOf(subject).remindedAt).toBeNull()
    expect(subject.isReminderDue(at('2026-09-29T11:00:00Z'))).toBe(true)
  })

  it('reports an unchanged revision as nothing and never fires without a reminder', () => {
    const subject = task({ dueAt: at('2026-09-28T12:00:00Z'), remindAt: null })
    expect(
      valid(
        subject.revise(
          { title: title(), dueAt: at('2026-09-28T12:00:00Z'), remindAt: null },
          at('2026-09-28T00:00:00Z'),
        ),
      ),
    ).toBe(false)
    expect(snapshotOf(subject).version).toBe(1)
    expect(subject.isReminderDue(at('2030-01-01T00:00:00Z'))).toBe(false)
    expect(subject.isOverdue(at('2026-09-28T12:00:01Z'))).toBe(true)
  })

  it('is completed or cancelled once, and a closed task neither changes nor reminds', () => {
    const subject = task({
      dueAt: at('2026-09-28T12:00:00Z'),
      remindAt: at('2026-09-28T11:00:00Z'),
    })
    valid(subject.complete('ana', at('2026-09-28T10:00:00Z')))
    expect(subject.cancel('ana', at('2026-09-28T10:01:00Z')).isLeft()).toBe(true)
    expect(subject.reassign(randomUUID(), at('2026-09-28T10:01:00Z')).isLeft()).toBe(true)
    expect(subject.isReminderDue(at('2026-09-28T11:00:00Z'))).toBe(false)
    expect(subject.isOverdue(at('2026-09-29T00:00:00Z'))).toBe(false)
    expect(snapshotOf(subject)).toMatchObject({ status: 'completed', closedBy: 'ana' })
  })

  it('refuses to reassign a task to the user who already has it', () => {
    const subject = task({ dueAt: at('2026-09-28T12:00:00Z'), remindAt: null })
    const assignee = snapshotOf(subject).assigneeId
    expect(subject.reassign(assignee, at('2026-09-28T00:00:00Z')).isLeft()).toBe(true)
  })
})
