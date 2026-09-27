import { randomUUID } from 'node:crypto'
import { InMemoryCrmUnitOfWork } from 'test/repositories/in-memory-crm-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { Account } from '@/domain/entities/account'
import type { DueReminderTenants } from './ports/due-reminder-tenants'
import { FireDueRemindersUseCase } from './use-cases/fire-due-reminders'
import { RecordActivityUseCase, ReviseActivityUseCase } from './use-cases/manage-activities'
import { CreateContactUseCase, EraseContactUseCase } from './use-cases/manage-contacts'
import { CorrectNoteUseCase, WriteNoteUseCase } from './use-cases/manage-notes'
import { CreateOpportunityUseCase } from './use-cases/manage-opportunities'
import { CreatePipelineUseCase } from './use-cases/manage-pipelines'
import { ChangeTaskUseCase, CreateTaskUseCase } from './use-cases/manage-tasks'
import { ForgetPartyUseCase } from './use-cases/project-parties'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

/** A clock the test moves forward. */
function movingClock(start: string) {
  let now = new Date(start)
  return {
    now: () => now,
    set: (iso: string) => {
      now = new Date(iso)
    },
  }
}

function account(tenantId: string, id: string, roles: string[] = ['prospect']) {
  const projected = Account.project(
    {
      tenantId,
      party: {
        kind: 'organization',
        legalName: `Conta ${id.slice(0, 4)}`,
        tradeName: null,
        roles,
        documentType: 'none',
        documentCountry: null,
        active: true,
      },
      now: new Date('2026-09-01T00:00:00Z'),
    },
    new UniqueEntityID(id),
  )
  if (!projected) throw new Error('not an account')
  return projected
}

async function world() {
  const unitOfWork = new InMemoryCrmUnitOfWork()
  const clock = movingClock('2026-09-27T12:00:00Z')
  const tenantId = randomUUID()
  const accountId = randomUUID()
  const otherAccountId = randomUUID()
  const ownerId = randomUUID()
  const disabledId = randomUUID()
  await unitOfWork.inTenant(tenantId, async (scope) => {
    await scope.accounts.create(account(tenantId, accountId))
    await scope.accounts.create(account(tenantId, otherAccountId))
    await scope.owners.register(ownerId, clock.now())
    await scope.owners.disable(disabledId, clock.now())
  })
  const context = { tenantId, actor: ownerId, requestId: 'req-1' }
  const keyed = () => ({ ...context, idempotencyKey: randomUUID() })
  const contact = async (on: string) =>
    valid(
      await new CreateContactUseCase(unitOfWork, clock).execute({
        context: keyed(),
        accountId: on,
        contact: { name: 'Maria Souza', lawfulBasis: 'contract' },
      }),
    ).contactId
  return {
    unitOfWork,
    clock,
    tenantId,
    accountId,
    otherAccountId,
    ownerId,
    disabledId,
    context,
    keyed,
    contact,
    record: new RecordActivityUseCase(unitOfWork, clock),
    reviseActivity: new ReviseActivityUseCase(unitOfWork, clock),
    createTask: new CreateTaskUseCase(unitOfWork, clock),
    changeTask: new ChangeTaskUseCase(unitOfWork, clock),
    writeNote: new WriteNoteUseCase(unitOfWork, clock),
    correctNote: new CorrectNoteUseCase(unitOfWork, clock),
  }
}

const call = {
  kind: 'call',
  occurredAt: '2026-09-27T11:30:00-00:00',
  title: 'Ligação de qualificação',
  summary: 'Maria confirmou o orçamento.\nRetornar na sexta.',
}

describe('activities', () => {
  it('takes the account from a contact subject and checks the participants', async () => {
    const w = await world()
    const maria = await w.contact(w.accountId)
    const stranger = await w.contact(w.otherAccountId)
    const refused = await w.record.execute({
      context: w.keyed(),
      subject: { type: 'contact', id: maria },
      activity: { ...call, contactIds: [stranger] },
    })
    expect(refused.isLeft() && refused.value.message).toMatch(/not a contact of this account/)
    const { activityId } = valid(
      await w.record.execute({
        context: w.keyed(),
        subject: { type: 'contact', id: maria },
        activity: { ...call, contactIds: [maria, maria] },
      }),
    )
    const activity = snapshotOf(w.unitOfWork.activities.get(activityId) as never) as {
      accountId: string
      contactIds: string[]
      recordedBy: string
    }
    expect(activity).toMatchObject({
      accountId: w.accountId,
      contactIds: [maria],
      recordedBy: w.ownerId,
    })
    expect(w.unitOfWork.accountKeys.has(w.accountId)).toBe(true)
  })

  it('refuses an activity in the future, on an erased contact or on an unknown subject', async () => {
    const w = await world()
    const maria = await w.contact(w.accountId)
    const future = await w.record.execute({
      context: w.keyed(),
      subject: { type: 'account', id: w.accountId },
      activity: { ...call, occurredAt: '2026-09-27T12:10:00Z' },
    })
    expect(future.isLeft() && future.value.message).toMatch(/plan a task/)
    valid(
      await new EraseContactUseCase(w.unitOfWork, w.clock).execute({
        context: w.context,
        contactId: maria,
      }),
    )
    const erased = await w.record.execute({
      context: w.keyed(),
      subject: { type: 'contact', id: maria },
      activity: call,
    })
    expect(erased.isLeft() && erased.value.message).toMatch(/erased/)
    const unknown = await w.record.execute({
      context: w.keyed(),
      subject: { type: 'opportunity', id: randomUUID() },
      activity: call,
    })
    expect(unknown.isLeft() && unknown.value.title).toBe('Resource not found')
  })

  it('records once per key and audits a correction by field names only', async () => {
    const w = await world()
    const key = w.keyed()
    const request = { context: key, subject: { type: 'account', id: w.accountId }, activity: call }
    const first = valid(await w.record.execute(request))
    const retried = valid(
      await w.record.execute({ ...request, context: { ...key, requestId: 'req-2' } }),
    )
    expect(retried.activityId).toBe(first.activityId)
    expect(w.unitOfWork.activities.size).toBe(1)
    expect(
      valid(
        await w.reviseActivity.execute({
          context: w.context,
          activityId: first.activityId,
          activity: { ...call, kind: 'meeting', summary: 'Maria pediu nova proposta.' },
        }),
      ),
    ).toEqual({ revised: true })
    expect(
      valid(
        await w.reviseActivity.execute({
          context: w.context,
          activityId: first.activityId,
          activity: { ...call, kind: 'meeting', summary: 'Maria pediu nova proposta.' },
        }),
      ),
    ).toEqual({ revised: false })
    const revised = w.unitOfWork.audit.filter((entry) => entry.action === 'activity.revised')
    expect(revised.map((entry) => entry.details)).toEqual([{ changed: ['kind', 'summary'] }])
    expect(JSON.stringify(w.unitOfWork.audit)).not.toMatch(/Maria|orçamento|Ligação/)
  })
})

describe('tasks', () => {
  it('needs an active assignee and an active account', async () => {
    const w = await world()
    const task = { title: 'Enviar proposta', dueAt: '2026-09-28T12:00:00Z' }
    const disabled = await w.createTask.execute({
      context: w.keyed(),
      subject: { type: 'account', id: w.accountId },
      assigneeId: w.disabledId,
      task,
    })
    expect(disabled.isLeft() && disabled.value.message).toMatch(/disabled user/)
    await w.unitOfWork.inTenant(w.tenantId, async (scope) => {
      const inactive = account(w.tenantId, randomUUID(), ['customer'])
      inactive.refresh(
        {
          kind: 'organization',
          legalName: 'Inativa',
          tradeName: null,
          roles: ['supplier'],
          documentType: 'none',
          documentCountry: null,
          active: true,
        },
        w.clock.now(),
      )
      await scope.accounts.create(inactive)
      const refused = await w.createTask.execute({
        context: w.keyed(),
        subject: { type: 'account', id: inactive.id.toString() },
        assigneeId: w.ownerId,
        task,
      })
      expect(refused.isLeft() && refused.value.message).toMatch(/active account/)
    })
  })

  it('sends each reminder once across runs and restarts, and again after a reschedule', async () => {
    const w = await world()
    const tenants: DueReminderTenants = { find: async () => [w.tenantId] }
    const { taskId } = valid(
      await w.createTask.execute({
        context: w.keyed(),
        subject: { type: 'account', id: w.accountId },
        assigneeId: w.ownerId,
        task: {
          title: 'Ligar para Maria',
          dueAt: '2026-09-28T12:00:00Z',
          remindAt: '2026-09-28T11:30:00Z',
        },
      }),
    )
    const scheduler = () => new FireDueRemindersUseCase(w.unitOfWork, tenants, w.clock)
    expect((await scheduler().execute()).sent).toBe(0)
    w.clock.set('2026-09-28T11:30:00Z')
    expect(await scheduler().execute()).toEqual({ tenants: 1, sent: 1 })
    expect((await scheduler().execute()).sent).toBe(0)
    const due = w.unitOfWork.published.filter((event) => event.eventType === 'crm.task.due')
    expect(due).toHaveLength(1)
    expect(JSON.stringify(due[0]?.payloadOf())).not.toMatch(/Maria/)

    valid(
      await w.changeTask.revise({
        context: w.context,
        taskId,
        task: {
          title: 'Ligar para Maria',
          dueAt: '2026-09-29T12:00:00Z',
          remindAt: '2026-09-29T11:30:00Z',
        },
      }),
    )
    w.clock.set('2026-09-29T11:30:00Z')
    expect((await scheduler().execute()).sent).toBe(1)
    expect(
      w.unitOfWork.published.filter((event) => event.eventType === 'crm.task.due'),
    ).toHaveLength(2)
  })

  it('completes or cancels once, and a closed task sends no reminder', async () => {
    const w = await world()
    const { taskId } = valid(
      await w.createTask.execute({
        context: w.keyed(),
        subject: { type: 'account', id: w.accountId },
        assigneeId: w.ownerId,
        task: { title: 'Visitar', dueAt: '2026-09-28T12:00:00Z', remindAt: '2026-09-28T09:00:00Z' },
      }),
    )
    valid(await w.changeTask.complete({ context: w.context, taskId }))
    const again = await w.changeTask.cancel({ context: w.context, taskId })
    expect(again.isLeft() && again.value.message).toMatch(/completed/)
    w.clock.set('2026-09-28T10:00:00Z')
    const run = await new FireDueRemindersUseCase(
      w.unitOfWork,
      { find: async () => [w.tenantId] },
      w.clock,
    ).execute()
    expect(run.sent).toBe(0)
    expect(w.unitOfWork.audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['task.created', 'task.completed']),
    )
  })

  it('reassigns only to an active owner', async () => {
    const w = await world()
    const { taskId } = valid(
      await w.createTask.execute({
        context: w.keyed(),
        subject: { type: 'account', id: w.accountId },
        assigneeId: w.ownerId,
        task: { title: 'Visitar', dueAt: '2026-09-28T12:00:00Z' },
      }),
    )
    const refused = await w.changeTask.reassign({
      context: w.context,
      taskId,
      assigneeId: w.disabledId,
    })
    expect(refused.isLeft()).toBe(true)
    const other = randomUUID()
    await w.unitOfWork.inTenant(w.tenantId, (scope) => scope.owners.register(other, w.clock.now()))
    valid(await w.changeTask.reassign({ context: w.context, taskId, assigneeId: other }))
    expect(w.unitOfWork.audit.at(-1)).toMatchObject({
      action: 'task.reassigned',
      details: { assigneeId: other },
    })
  })
})

describe('notes', () => {
  it('keeps the earlier text when corrected, on an opportunity of the account', async () => {
    const w = await world()
    const { pipelineId } = valid(
      await new CreatePipelineUseCase(w.unitOfWork, w.clock).execute({
        context: w.keyed(),
        name: 'Vendas',
        stages: [{ name: 'Qualificação', probabilityBps: 1000 }],
      }),
    )
    const pipeline = snapshotOf(w.unitOfWork.pipelines.get(pipelineId) as never) as {
      stages: { id: string }[]
    }
    const { opportunityId } = valid(
      await new CreateOpportunityUseCase(w.unitOfWork, w.clock).execute({
        context: w.keyed(),
        accountId: w.accountId,
        ownerId: w.ownerId,
        pipelineId,
        stageId: pipeline.stages[0]?.id ?? '',
        terms: {
          title: 'Renovação',
          expectedValue: { amount: '100', currency: 'BRL' },
          expectedCloseOn: '2026-12-01',
        },
      }),
    )
    const { noteId } = valid(
      await w.writeNote.execute({
        context: w.keyed(),
        subject: { type: 'opportunity', id: opportunityId },
        body: 'Desconto máximo: 10%',
      }),
    )
    expect(
      valid(
        await w.correctNote.execute({ context: w.context, noteId, body: 'Desconto máximo: 7%' }),
      ),
    ).toEqual({
      revision: 2,
    })
    const same = await w.correctNote.execute({
      context: w.context,
      noteId,
      body: 'Desconto máximo: 7%',
    })
    expect(same.isLeft()).toBe(true)
    expect(w.unitOfWork.noteRevisions.get(noteId)?.map((revision) => revision.body.value)).toEqual([
      'Desconto máximo: 10%',
      'Desconto máximo: 7%',
    ])
    expect(snapshotOf(w.unitOfWork.notes.get(noteId) as never)).toMatchObject({
      accountId: w.accountId,
    })
  })
})

describe('party erasure', () => {
  it('cancels the open tasks and destroys the account key; nothing is changed afterwards', async () => {
    const w = await world()
    const { taskId } = valid(
      await w.createTask.execute({
        context: w.keyed(),
        subject: { type: 'account', id: w.accountId },
        assigneeId: w.ownerId,
        task: { title: 'Visitar', dueAt: '2026-09-28T12:00:00Z', remindAt: '2026-09-28T09:00:00Z' },
      }),
    )
    const { noteId } = valid(
      await w.writeNote.execute({
        context: w.keyed(),
        subject: { type: 'account', id: w.accountId },
        body: 'Contato: Maria',
      }),
    )
    await w.unitOfWork.inTenant(w.tenantId, (scope) =>
      new ForgetPartyUseCase(w.clock).executeInScope(scope, w.accountId),
    )
    expect(snapshotOf(w.unitOfWork.tasks.get(taskId) as never)).toMatchObject({
      status: 'cancelled',
      closedBy: 'crm:party-erased',
    })
    expect(w.unitOfWork.accountKeys.has(w.accountId)).toBe(false)
    const correction = await w.correctNote.execute({ context: w.context, noteId, body: 'Outro' })
    expect(correction.isLeft() && correction.value.message).toMatch(/erased/)
  })
})
