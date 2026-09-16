import { randomBytes, randomUUID } from 'node:crypto'
import { type EventEnvelope, findEvent } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FinancialModuleEventHandlers } from '@/application/consume-module-events'
import {
  DefineCategoryUseCase,
  DefinePaymentMethodUseCase,
} from '@/application/use-cases/manage-dimensions'
import {
  CancelReceivableUseCase,
  DraftReceivableUseCase,
  PostReceivableUseCase,
  RecordSettlementUseCase,
  ReverseReceivableUseCase,
  ReverseSettlementUseCase,
} from '@/application/use-cases/manage-receivables'
import type { TermsInput } from '@/application/use-cases/receivable-inputs'
import { FinancialDatabase } from '@/infrastructure/database/drizzle/financial-database'
import { auditHash, GENESIS_HASH } from '@/infrastructure/database/drizzle/title-store'

const clock = { now: () => new Date() }
let database: FinancialDatabase
let application: ReturnType<typeof postgres>
let administrator: ReturnType<typeof postgres>
let handlers: FinancialModuleEventHandlers

beforeAll(() => {
  database = new FinancialDatabase({ url: process.env.DATABASE_URL ?? '' })
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  handlers = new FinancialModuleEventHandlers(database, clock)
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), application?.end(), administrator?.end()])
})

function value<T>(result: { isLeft(): boolean; value: unknown }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

async function deliver(
  tenantId: string,
  eventType: string,
  payload: unknown,
  eventId = randomUUID(),
) {
  const envelope: EventEnvelope = {
    eventId,
    tenantId,
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    traceId: randomBytes(16).toString('hex'),
    payload,
  }
  const handler = handlers.handlers[eventType]
  if (!handler) throw new Error(`no handler for ${eventType}`)
  await handler(envelope)
}

const customerDetails = {
  kind: 'organization',
  legalName: 'Acme Comércio Ltda',
  tradeName: null,
  email: 'finance@acme.example',
  phone: '+5511999990000',
  address: 'Rua Um, 42, São Paulo',
}

async function workspace() {
  const tenantId = randomUUID()
  const partyId = randomUUID()
  await deliver(tenantId, 'parties.party.registered', {
    partyId,
    ...customerDetails,
    roles: ['customer'],
  })
  const categoryId = value<{ id: string }>(
    await new DefineCategoryUseCase(database, clock).execute({
      tenantId,
      code: '1.01',
      name: 'Product sales',
      nature: 'revenue',
    }),
  ).id
  const paymentMethodId = value<{ id: string }>(
    await new DefinePaymentMethodUseCase(database, clock).execute({
      tenantId,
      kind: 'pix',
      code: 'PIX',
      name: 'Pix',
    }),
  ).id
  const context = (key = randomUUID()) => ({
    tenantId,
    actor: 'user-1',
    requestId: null,
    idempotencyKey: key,
  })
  const terms: TermsInput = {
    partyId,
    documentNumber: 'NF-1001',
    currency: 'BRL',
    categoryId,
    issuedOn: '2026-09-01',
    installments: [
      { dueOn: '2026-09-10', amount: '6000' },
      { dueOn: '2026-10-10', amount: '4000' },
    ],
  }
  return { tenantId, partyId, categoryId, paymentMethodId, context, terms }
}

async function outboxOf(tenantId: string) {
  return administrator<{ event_type: string; payload: unknown }[]>`
    select event_type, payload from outbox where tenant_id = ${tenantId} order by created_at, id`
}

describe('receivables', () => {
  it('drafts once per idempotency key and forgets a refused attempt', async () => {
    const { context, terms, tenantId } = await workspace()
    const draft = new DraftReceivableUseCase(database, clock)
    const key = randomUUID()

    const refused = await draft.execute({
      context: context(key),
      terms: { ...terms, partyId: randomUUID() },
    })
    expect(refused.isLeft()).toBe(true)

    const first = value<{ id: string }>(await draft.execute({ context: context(key), terms }))
    const replay = value<{ id: string }>(await draft.execute({ context: context(key), terms }))
    expect(replay.id).toBe(first.id)
    const reused = await draft.execute({
      context: context(key),
      terms: { ...terms, documentNumber: 'NF-9999' },
    })
    expect(reused.isLeft() && reused.value.message).toMatch(/different request/)

    const concurrent = randomUUID()
    const racing = await Promise.all([
      draft.execute({ context: context(concurrent), terms }),
      draft.execute({ context: context(concurrent), terms }),
    ])
    expect(new Set(racing.map((result) => value<{ id: string }>(result).id)).size).toBe(1)

    const page = await database.listReceivables(tenantId, {
      view: 'draft',
      today: '2026-09-16',
      limit: 50,
      offset: 0,
    })
    expect(page.total).toBe(2)
    expect(page.data[0]).toMatchObject({ partyName: 'Acme Comércio Ltda', total: '10000' })
  })

  it('refuses a category of the wrong nature and a party that is not a customer', async () => {
    const { context, terms, tenantId } = await workspace()
    const expense = value<{ id: string }>(
      await new DefineCategoryUseCase(database, clock).execute({
        tenantId,
        code: '2.01',
        name: 'Rent',
        nature: 'expense',
      }),
    ).id
    const draft = new DraftReceivableUseCase(database, clock)
    expect(
      (
        await draft.execute({ context: context(), terms: { ...terms, categoryId: expense } })
      ).isLeft(),
    ).toBe(true)
    const supplier = randomUUID()
    await deliver(tenantId, 'parties.party.registered', {
      partyId: supplier,
      ...customerDetails,
      roles: ['supplier'],
    })
    expect(
      (
        await draft.execute({ context: context(), terms: { ...terms, partyId: supplier } })
      ).isLeft(),
    ).toBe(true)
  })

  it('posts, settles in parts, reverses a settlement and publishes each fact', async () => {
    const { context, terms, tenantId, paymentMethodId } = await workspace()
    const { id } = value<{ id: string }>(
      await new DraftReceivableUseCase(database, clock).execute({ context: context(), terms }),
    )
    value(
      await new PostReceivableUseCase(database, clock).execute({ context: context(), titleId: id }),
    )

    const settle = new RecordSettlementUseCase(database, clock)
    const key = randomUUID()
    const settlement = {
      installmentNumber: 1,
      settledOn: '2026-09-12',
      received: '6100',
      interest: '100',
      paymentMethodId,
    }
    const first = value<{ settlementId: string; outstanding: string }>(
      await settle.execute({ context: context(key), titleId: id, settlement }),
    )
    const replayed = value<{ settlementId: string }>(
      await settle.execute({ context: context(key), titleId: id, settlement }),
    )
    expect(replayed.settlementId).toBe(first.settlementId)
    expect(first.outstanding).toBe('4000')

    const summary = await database.receivablesSummary(tenantId, '2026-10-20')
    expect(summary.currencies).toEqual([
      expect.objectContaining({ outstanding: '4000', overdue: '4000' }),
    ])
    const aging: Record<string, string> = { ...summary.currencies[0]?.aging }
    expect(Object.values(aging).reduce((sum, amount) => sum + BigInt(amount), 0n)).toBe(4000n)
    expect(aging).toMatchObject({ days1To30: '4000' })
    expect(
      (
        await database.listReceivables(tenantId, {
          view: 'overdue',
          today: '2026-10-20',
          limit: 50,
          offset: 0,
        })
      ).total,
    ).toBe(1)

    expect(
      (
        await new ReverseReceivableUseCase(database, clock).execute({
          context: context(),
          titleId: id,
          reason: 'Issued twice',
        })
      ).isLeft(),
    ).toBe(true)
    const reversed = value<{ outstanding: string }>(
      await new ReverseSettlementUseCase(database, clock).execute({
        context: context(),
        titleId: id,
        settlementId: first.settlementId,
        reason: 'Payment bounced',
      }),
    )
    expect(reversed.outstanding).toBe('10000')

    const detail = await database.receivableDetail(tenantId, id, '2026-09-16')
    expect(detail?.settlements).toEqual([
      expect.objectContaining({ id: first.settlementId, reversalReason: 'Payment bounced' }),
    ])
    expect(detail?.timeline.map((entry) => entry.action)).toEqual([
      'receivable.drafted',
      'receivable.posted',
      'settlement.recorded',
      'settlement.reversed',
    ])

    const events = await outboxOf(tenantId)
    expect(events.map((event) => event.event_type)).toEqual([
      'financial.receivable.posted',
      'financial.settlement.recorded',
      'financial.settlement.reversed',
    ])
    for (const event of events) {
      const definition = findEvent(event.event_type, 1)
      expect(definition?.payload.safeParse(event.payload).success).toBe(true)
    }
  })

  it('keeps posted history immutable in the database, not only in the aggregate', async () => {
    const { context, terms, tenantId } = await workspace()
    const { id } = value<{ id: string }>(
      await new DraftReceivableUseCase(database, clock).execute({ context: context(), terms }),
    )
    value(
      await new PostReceivableUseCase(database, clock).execute({ context: context(), titleId: id }),
    )
    value(
      await new RecordSettlementUseCase(database, clock).execute({
        context: context(),
        titleId: id,
        settlement: { installmentNumber: 1, settledOn: '2026-09-02', received: '100' },
      }),
    )
    const asTenant = <T>(statement: (sql: postgres.TransactionSql) => Promise<T>) =>
      application.begin(async (sql) => {
        await sql`select set_config('app.current_tenant', ${tenantId}, true)`
        return statement(sql)
      })
    await expect(asTenant((sql) => sql`update title_settlements set received = 1`)).rejects.toThrow(
      /permission denied/,
    )
    await expect(asTenant((sql) => sql`delete from title_settlements`)).rejects.toThrow(
      /permission denied/,
    )
    await expect(asTenant((sql) => sql`delete from title_installments`)).rejects.toThrow(
      /cannot be removed/,
    )
    await expect(asTenant((sql) => sql`update audit_log set action = 'x'`)).rejects.toThrow()
  })

  it('chains every audit entry to the one before it', async () => {
    const { context, terms, tenantId } = await workspace()
    const { id } = value<{ id: string }>(
      await new DraftReceivableUseCase(database, clock).execute({ context: context(), terms }),
    )
    value(
      await new CancelReceivableUseCase(database, clock).execute({
        context: context(),
        titleId: id,
        reason: 'Wrong customer',
      }),
    )
    const rows = await administrator<
      {
        sequence: string
        tenant_id: string
        actor: string
        subject_type: string
        subject_id: string
        action: string
        occurred_at: Date
        request_id: string | null
        trace_id: string | null
        details: Record<string, unknown>
        previous_hash: string
        hash: string
      }[]
    >`select * from audit_log where tenant_id = ${tenantId} order by sequence`
    let previous = GENESIS_HASH
    for (const row of rows) {
      expect(row.previous_hash).toBe(previous)
      expect(
        auditHash(previous, {
          sequence: Number(row.sequence),
          tenantId: row.tenant_id,
          actor: row.actor,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          action: row.action,
          occurredAt: row.occurred_at,
          requestId: row.request_id,
          traceId: row.trace_id,
          details: row.details,
        }),
      ).toBe(row.hash)
      previous = row.hash
    }
    expect(rows.map((row) => row.action)).toEqual(['receivable.drafted', 'receivable.cancelled'])
  })

  it('never shows one workspace the receivables of another', async () => {
    const owner = await workspace()
    const { id } = value<{ id: string }>(
      await new DraftReceivableUseCase(database, clock).execute({
        context: owner.context(),
        terms: owner.terms,
      }),
    )
    const other = await workspace()
    expect(await database.receivableDetail(other.tenantId, id, '2026-09-16')).toBeNull()
    expect(
      (
        await new PostReceivableUseCase(database, clock).execute({
          context: other.context(),
          titleId: id,
        })
      ).isLeft(),
    ).toBe(true)
  })
})

describe('following sales and parties', () => {
  it('raises one draft per confirmed order and withdraws it when the order is cancelled', async () => {
    const { tenantId, partyId } = await workspace()
    const orderId = randomUUID()
    const confirmed = {
      orderId,
      orderVersion: 2,
      customerId: partyId,
      reservationId: randomUUID(),
      confirmedAt: '2026-09-15T21:30:00.000Z',
      lines: [
        {
          lineId: randomUUID(),
          itemId: randomUUID(),
          quantity: '2',
          description: 'Coffee',
          unitPrice: { amount: '1250', currency: 'BRL' },
          lineTotal: { amount: '2500', currency: 'BRL' },
        },
      ],
      total: { amount: '2500', currency: 'BRL' },
    }
    const eventId = randomUUID()
    await deliver(tenantId, 'sales.order.confirmed', confirmed, eventId)
    await deliver(tenantId, 'sales.order.confirmed', confirmed, eventId)
    await deliver(tenantId, 'sales.order.confirmed', confirmed)
    const drafts = await database.listReceivables(tenantId, {
      view: 'draft',
      today: '2026-09-16',
      limit: 50,
      offset: 0,
    })
    expect(drafts.data).toEqual([
      expect.objectContaining({
        origin: { type: 'sales-order', orderId },
        issuedOn: '2026-09-15',
        total: '2500',
        documentNumber: `SO-${orderId.slice(-8).toUpperCase()}`,
      }),
    ])

    await deliver(tenantId, 'sales.order.cancelled', {
      orderId,
      orderVersion: 3,
      reservationId: null,
      cancelledAt: '2026-09-16T10:00:00.000Z',
      reason: null,
    })
    expect(
      (
        await database.listReceivables(tenantId, {
          view: 'closed',
          today: '2026-09-16',
          limit: 50,
          offset: 0,
        })
      ).total,
    ).toBe(1)
  })

  it('destroys the projected name of an erased party and never restores it', async () => {
    const { tenantId, partyId, context, terms } = await workspace()
    await deliver(tenantId, 'parties.party.erased', { partyId })
    await deliver(tenantId, 'parties.party.updated', {
      partyId,
      ...customerDetails,
      roles: ['customer'],
      active: true,
    })
    expect(await database.listCustomers(tenantId)).toEqual([])
    expect(
      (
        await new DraftReceivableUseCase(database, clock).execute({ context: context(), terms })
      ).isLeft(),
    ).toBe(true)
  })
})
