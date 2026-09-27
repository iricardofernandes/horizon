import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CrmModuleEventHandlers } from '@/application/consume-module-events'
import { FireDueRemindersUseCase } from '@/application/use-cases/fire-due-reminders'
import { RecordActivityUseCase } from '@/application/use-cases/manage-activities'
import { CreateContactUseCase } from '@/application/use-cases/manage-contacts'
import { CorrectNoteUseCase, WriteNoteUseCase } from '@/application/use-cases/manage-notes'
import {
  ChangeOpportunityUseCase,
  CreateOpportunityUseCase,
} from '@/application/use-cases/manage-opportunities'
import { CreatePipelineUseCase } from '@/application/use-cases/manage-pipelines'
import { ChangeTaskUseCase, CreateTaskUseCase } from '@/application/use-cases/manage-tasks'
import type { Either } from '@/core/either'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { CrmDatabase } from '@/infrastructure/database/drizzle/crm-database'
import { RelayDueReminderTenants } from '@/infrastructure/scheduling/relay-due-reminder-tenants'

/**
 * Phase 57 on PostgreSQL: record text sealed under the account key and shredded with the
 * party, append-only note revisions, reminders sent once by concurrent and restarted
 * schedulers, a relay role that cannot read text, and ordered, tenant-scoped timelines.
 */
const clock = { now: () => new Date() }
let database: CrmDatabase
let handlers: CrmModuleEventHandlers
let application: ReturnType<typeof postgres>
let administrator: ReturnType<typeof postgres>
let relay: ReturnType<typeof postgres>
let relayUrl: string

beforeAll(() => {
  database = new CrmDatabase({
    url: process.env.DATABASE_URL ?? '',
    secretBox: new AesGcmSecretBox(),
  })
  handlers = new CrmModuleEventHandlers(database, clock)
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  const url = new URL(process.env.DATABASE_URL ?? '')
  url.username = 'horizon_relay'
  url.password = 'test'
  relayUrl = url.toString()
  relay = postgres(relayUrl, { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([
    database?.close(),
    application?.end(),
    administrator?.end(),
    relay?.end(),
  ])
})

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

async function deliver(tenantId: string, eventType: string, payload: object, eventVersion = 2) {
  const event: EventEnvelope = {
    eventId: randomUUID(),
    eventType,
    eventVersion,
    occurredAt: new Date().toISOString(),
    tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload,
  }
  const handler = handlers.handlers[eventType]
  if (!handler) throw new Error(`no handler for ${eventType}`)
  await handler(event)
}

/** A workspace with a prospect account, a contact, an owner and an opportunity. */
async function workspace() {
  const tenantId = randomUUID()
  const accountId = randomUUID()
  const ownerId = randomUUID()
  await deliver(tenantId, 'parties.party.registered', {
    partyId: accountId,
    kind: 'organization',
    legalName: 'Umbrella Ltda',
    tradeName: null,
    email: null,
    phone: null,
    address: null,
    documentType: 'none',
    documentCountry: null,
    roles: ['prospect'],
  })
  await deliver(
    tenantId,
    'identity.user.registered',
    { tenantId, userId: ownerId, registeredAt: new Date().toISOString() },
    1,
  )
  const context = { tenantId, actor: ownerId, requestId: null }
  const keyed = () => ({ ...context, idempotencyKey: randomUUID() })
  const { contactId } = valid(
    await new CreateContactUseCase(database, clock).execute({
      context: keyed(),
      accountId,
      contact: { name: 'Maria Souza', lawfulBasis: 'contract' },
    }),
  )
  const { pipelineId } = valid(
    await new CreatePipelineUseCase(database, clock).execute({
      context: keyed(),
      name: 'Vendas',
      stages: [
        { name: 'Qualificação', probabilityBps: 1000 },
        { name: 'Proposta', probabilityBps: 5000 },
      ],
    }),
  )
  const stages = (await database.pipelineDetail(tenantId, pipelineId))?.stages ?? []
  const { opportunityId } = valid(
    await new CreateOpportunityUseCase(database, clock).execute({
      context: keyed(),
      accountId,
      ownerId,
      pipelineId,
      stageId: stages[0]?.id ?? '',
      terms: {
        title: 'Renovação Umbrella',
        expectedValue: { amount: '100000', currency: 'BRL' },
        expectedCloseOn: '2026-12-01',
      },
    }),
  )
  return { tenantId, accountId, ownerId, contactId, opportunityId, stages, context, keyed }
}

type World = Awaited<ReturnType<typeof workspace>>

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const minutesAhead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

function task(
  w: World,
  subject: { type: string; id: string },
  title: string,
  remindAt: string | null,
) {
  return new CreateTaskUseCase(database, clock).execute({
    context: w.keyed(),
    subject,
    assigneeId: w.ownerId,
    task: { title, dueAt: minutesAhead(60), remindAt },
  })
}

describe('activities, tasks and notes on PostgreSQL', () => {
  it('stores record text only as ciphertext and shreds it with the party', async () => {
    const w = await workspace()
    valid(
      await new RecordActivityUseCase(database, clock).execute({
        context: w.keyed(),
        subject: { type: 'contact', id: w.contactId },
        activity: {
          kind: 'call',
          occurredAt: minutesAgo(10),
          title: 'Ligação com Maria',
          summary: 'Maria quer proposta até sexta',
          contactIds: [w.contactId],
        },
      }),
    )
    const { taskId } = valid(
      await task(
        w,
        { type: 'account', id: w.accountId },
        'Enviar proposta à Maria',
        minutesAhead(30),
      ),
    )
    valid(
      await new WriteNoteUseCase(database, clock).execute({
        context: w.keyed(),
        subject: { type: 'account', id: w.accountId },
        body: 'Maria decide com o diretor',
      }),
    )
    for (const table of ['activities', 'tasks', 'note_revisions', 'audit_log', 'outbox']) {
      const rows =
        await administrator`select * from ${administrator(table)} where tenant_id = ${w.tenantId}`
      expect(JSON.stringify(rows), table).not.toMatch(/Maria|proposta|diretor/)
    }
    const before = await database.timeline(
      w.tenantId,
      { accountId: w.accountId },
      { limit: 50, offset: 0 },
      new Date(),
    )
    expect(JSON.stringify(before.data)).toMatch(/Ligação com Maria/)

    await deliver(w.tenantId, 'parties.party.erased', { partyId: w.accountId }, 1)
    const [key] =
      await administrator`select material, erased_at from account_data_keys where id = ${w.accountId}`
    expect(key?.material).toBeNull()
    expect(key?.erased_at).not.toBeNull()
    await expect(
      administrator`update account_data_keys set material = 'back', erased_at = null where id = ${w.accountId}`,
    ).rejects.toThrow(/cannot be restored/)
    const after = await database.timeline(
      w.tenantId,
      { accountId: w.accountId },
      { limit: 50, offset: 0 },
      new Date(),
    )
    expect(after.total).toBe(before.total)
    expect(JSON.stringify(after.data)).not.toMatch(/Maria|proposta|diretor/)
    expect(await database.taskDetail(w.tenantId, taskId, new Date())).toMatchObject({
      status: 'cancelled',
      title: null,
    })
  })

  it('keeps every note revision, and the table refuses to rewrite one', async () => {
    const w = await workspace()
    const { noteId } = valid(
      await new WriteNoteUseCase(database, clock).execute({
        context: w.keyed(),
        subject: { type: 'opportunity', id: w.opportunityId },
        body: 'Desconto máximo: 10%',
      }),
    )
    valid(
      await new CorrectNoteUseCase(database, clock).execute({
        context: w.context,
        noteId,
        body: 'Desconto máximo: 7%',
      }),
    )
    const note = await database.noteDetail(w.tenantId, noteId)
    expect(note?.body).toBe('Desconto máximo: 7%')
    expect(note?.revisions.map((revision) => revision.body)).toEqual([
      'Desconto máximo: 10%',
      'Desconto máximo: 7%',
    ])
    await expect(
      administrator`update note_revisions set author = 'x' where note_id = ${noteId}`,
    ).rejects.toThrow(/append-only/)
    await expect(
      administrator`delete from note_revisions where note_id = ${noteId}`,
    ).rejects.toThrow(/append-only/)
  })

  it('sends each reminder once, with two schedulers at once and after a restart', async () => {
    const w = await workspace()
    const due = [
      valid(await task(w, { type: 'account', id: w.accountId }, 'Ligar para Maria', minutesAgo(1))),
      valid(
        await task(
          w,
          { type: 'opportunity', id: w.opportunityId },
          'Rever proposta',
          minutesAgo(2),
        ),
      ),
    ]
    valid(await task(w, { type: 'account', id: w.accountId }, 'Mais tarde', minutesAhead(30)))
    valid(await task(w, { type: 'account', id: w.accountId }, 'Sem lembrete', null))

    const scheduler = () => {
      const own = new CrmDatabase({
        url: process.env.DATABASE_URL ?? '',
        secretBox: new AesGcmSecretBox(),
      })
      const tenants = new RelayDueReminderTenants(relayUrl)
      return {
        run: () => new FireDueRemindersUseCase(own, tenants, clock).execute(),
        close: () => Promise.all([own.close(), tenants.close()]),
      }
    }
    const [first, second] = [scheduler(), scheduler()]
    await Promise.all([first.run(), second.run(), first.run(), second.run()])
    await Promise.all([first.close(), second.close()])
    const restarted = scheduler()
    await restarted.run()
    await restarted.close()

    const sent = await administrator<{ payload: { taskId: string } }[]>`
      select payload from outbox where tenant_id = ${w.tenantId} and event_type = 'crm.task.due'`
    expect(sent.map((row) => row.payload.taskId).sort()).toEqual(
      due.map((item) => item.taskId).sort(),
    )
    expect(JSON.stringify(sent)).not.toMatch(/Maria|proposta/)
    const reminded = await administrator`
      select count(*)::int as n from tasks where tenant_id = ${w.tenantId} and reminded_at is not null`
    expect(reminded[0]?.n).toBe(2)

    // Rescheduling arms the reminder again; the next run sends it once more.
    const [firstDue] = due
    valid(
      await new ChangeTaskUseCase(database, clock).revise({
        context: w.context,
        taskId: firstDue?.taskId ?? '',
        task: { title: 'Ligar para Maria', dueAt: minutesAhead(90), remindAt: minutesAgo(0.5) },
      }),
    )
    const again = scheduler()
    await again.run()
    await again.close()
    const resent = await administrator`
      select count(*)::int as n from outbox where tenant_id = ${w.tenantId} and event_type = 'crm.task.due'`
    expect(resent[0]?.n).toBe(3)
  })

  it('lets the relay role see which tenants have reminders, and no text', async () => {
    const w = await workspace()
    valid(await task(w, { type: 'account', id: w.accountId }, 'Ligar para Maria', minutesAhead(10)))
    const rows =
      await relay`select tenant_id, status, remind_at, reminded_at from tasks where tenant_id = ${w.tenantId}`
    expect(rows).toHaveLength(1)
    await expect(relay`select title_ciphertext from tasks limit 1`).rejects.toThrow(
      /permission denied/,
    )
    await expect(relay`select * from activities limit 1`).rejects.toThrow(/permission denied/)
    await expect(relay`select * from account_data_keys limit 1`).rejects.toThrow(
      /permission denied/,
    )
    await expect(relay`update tasks set reminded_at = now()`).rejects.toThrow(/permission denied/)
  })

  it('orders a timeline newest first, pages it, and scopes it to the tenant', async () => {
    const w = await workspace()
    const record = new RecordActivityUseCase(database, clock)
    for (const [title, minutes, subject] of [
      ['Visita inicial', 300, { type: 'account', id: w.accountId }],
      ['Reunião de proposta', 120, { type: 'opportunity', id: w.opportunityId }],
      ['E-mail de follow-up', 30, { type: 'contact', id: w.contactId }],
    ] as const)
      valid(
        await record.execute({
          context: w.keyed(),
          subject,
          activity: { kind: 'meeting', occurredAt: minutesAgo(minutes), title },
        }),
      )
    valid(
      await new ChangeOpportunityUseCase(database, clock).move({
        context: w.context,
        opportunityId: w.opportunityId,
        stageId: w.stages[1]?.id ?? '',
      }),
    )
    valid(
      await new WriteNoteUseCase(database, clock).execute({
        context: w.keyed(),
        subject: { type: 'opportunity', id: w.opportunityId },
        body: 'Proposta enviada',
      }),
    )
    const page = { limit: 50, offset: 0 }
    const account = await database.timeline(
      w.tenantId,
      { accountId: w.accountId },
      page,
      new Date(),
    )
    const instants = account.data.map((entry) => entry.at.getTime())
    expect(instants).toEqual([...instants].sort((a, b) => b - a))
    expect(account.data.map((entry) => entry.kind).sort()).toEqual([
      'activity',
      'activity',
      'activity',
      'note',
      'opportunity-event',
      'opportunity-event',
    ])
    expect(account.data.at(-1)).toMatchObject({
      kind: 'activity',
      record: { kind: 'meeting', title: 'Visita inicial' },
    })

    const opportunity = await database.timeline(
      w.tenantId,
      { opportunityId: w.opportunityId },
      page,
      new Date(),
    )
    expect(opportunity.total).toBe(4)
    expect(opportunity.data.filter((entry) => entry.kind === 'opportunity-event')).toHaveLength(2)
    expect(JSON.stringify(opportunity.data)).not.toMatch(/Visita inicial|follow-up/)

    const second = await database.timeline(
      w.tenantId,
      { accountId: w.accountId },
      { limit: 2, offset: 2 },
      new Date(),
    )
    expect(second.total).toBe(account.total)
    expect(second.data.map((entry) => entry.at)).toEqual(
      account.data.slice(2, 4).map((entry) => entry.at),
    )

    const intruder = randomUUID()
    expect(await database.timeline(intruder, { accountId: w.accountId }, page, new Date())).toEqual(
      {
        data: [],
        total: 0,
      },
    )
    for (const table of ['account_data_keys', 'activities', 'tasks', 'notes', 'note_revisions']) {
      const visible = await application.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${intruder}, true)`
        return tx`select count(*)::int as n from ${tx(table)}`
      })
      expect(visible[0]?.n, table).toBe(0)
    }
  })

  it('lists my agenda: open tasks due by the horizon, overdue flagged', async () => {
    const w = await workspace()
    const create = (title: string, dueAt: string) =>
      new CreateTaskUseCase(database, clock).execute({
        context: w.keyed(),
        subject: { type: 'account', id: w.accountId },
        assigneeId: w.ownerId,
        task: { title, dueAt },
      })
    valid(await create('Atrasada', minutesAgo(60)))
    valid(await create('Hoje', minutesAhead(60)))
    valid(await create('Semana que vem', minutesAhead(60 * 24 * 7)))
    const { taskId: done } = valid(await create('Feita', minutesAhead(30)))
    valid(
      await new ChangeTaskUseCase(database, clock).complete({ context: w.context, taskId: done }),
    )
    const agenda = await database.listTasks(
      w.tenantId,
      {
        assigneeId: w.ownerId,
        accountId: null,
        status: 'open',
        dueBefore: new Date(Date.now() + 24 * 60 * 60_000),
        limit: 50,
        offset: 0,
      },
      new Date(),
    )
    expect(agenda.data.map((item) => [item.title, item.overdue])).toEqual([
      ['Atrasada', true],
      ['Hoje', false],
    ])
  })
})
