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
  CancelTitleUseCase,
  DraftTitleUseCase,
  PostTitleUseCase,
  RecordSettlementUseCase,
  ReverseSettlementUseCase,
  ReverseTitleUseCase,
} from '@/application/use-cases/manage-titles'
import type { TermsInput } from '@/application/use-cases/title-inputs'
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
    const draft = new DraftTitleUseCase(database, clock, 'receivable')
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

    const page = await database.listTitles(tenantId, 'receivable', {
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
    const draft = new DraftTitleUseCase(database, clock, 'receivable')
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
      await new DraftTitleUseCase(database, clock, 'receivable').execute({
        context: context(),
        terms,
      }),
    )
    value(
      await new PostTitleUseCase(database, clock, 'receivable').execute({
        context: context(),
        titleId: id,
      }),
    )

    const settle = new RecordSettlementUseCase(database, clock, 'receivable')
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

    const summary = await database.titlesSummary(tenantId, 'receivable', '2026-10-20')
    expect(summary.currencies).toEqual([
      expect.objectContaining({ outstanding: '4000', overdue: '4000' }),
    ])
    const aging: Record<string, string> = { ...summary.currencies[0]?.aging }
    expect(Object.values(aging).reduce((sum, amount) => sum + BigInt(amount), 0n)).toBe(4000n)
    expect(aging).toMatchObject({ days1To30: '4000' })
    expect(
      (
        await database.listTitles(tenantId, 'receivable', {
          view: 'overdue',
          today: '2026-10-20',
          limit: 50,
          offset: 0,
        })
      ).total,
    ).toBe(1)

    expect(
      (
        await new ReverseTitleUseCase(database, clock, 'receivable').execute({
          context: context(),
          titleId: id,
          reason: 'Issued twice',
        })
      ).isLeft(),
    ).toBe(true)
    const reversed = value<{ outstanding: string }>(
      await new ReverseSettlementUseCase(database, clock, 'receivable').execute({
        context: context(),
        titleId: id,
        settlementId: first.settlementId,
        reason: 'Payment bounced',
      }),
    )
    expect(reversed.outstanding).toBe('10000')

    const detail = await database.titleDetail(tenantId, 'receivable', id, '2026-09-16')
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
      await new DraftTitleUseCase(database, clock, 'receivable').execute({
        context: context(),
        terms,
      }),
    )
    value(
      await new PostTitleUseCase(database, clock, 'receivable').execute({
        context: context(),
        titleId: id,
      }),
    )
    value(
      await new RecordSettlementUseCase(database, clock, 'receivable').execute({
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
      await new DraftTitleUseCase(database, clock, 'receivable').execute({
        context: context(),
        terms,
      }),
    )
    value(
      await new CancelTitleUseCase(database, clock, 'receivable').execute({
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
      await new DraftTitleUseCase(database, clock, 'receivable').execute({
        context: owner.context(),
        terms: owner.terms,
      }),
    )
    const other = await workspace()
    expect(await database.titleDetail(other.tenantId, 'receivable', id, '2026-09-16')).toBeNull()
    expect(
      (
        await new PostTitleUseCase(database, clock, 'receivable').execute({
          context: other.context(),
          titleId: id,
        })
      ).isLeft(),
    ).toBe(true)
  })
})

describe('the cash flow outlook', () => {
  it('keeps what is owed apart from what is merely expected', async () => {
    const { tenantId, context, terms } = await workspace()
    const drafting = new DraftTitleUseCase(database, clock, 'receivable')
    const draft = async (stage: 'forecast' | 'effective', dueOn: string, amount: string) =>
      value<{ id: string }>(
        await drafting.execute({
          context: context(),
          terms: {
            ...terms,
            documentNumber: `NF-${dueOn}-${amount}`,
            installments: [{ dueOn, amount }],
          },
          stage,
        }),
      ).id

    const owed = await draft('effective', '2026-10-15', '30000')
    value(
      await new PostTitleUseCase(database, clock, 'receivable').execute({
        context: context(),
        titleId: owed,
      }),
    )
    await draft('forecast', '2026-10-20', '50000')
    await draft('forecast', '2026-11-05', '70000')

    const outlook = await database.cashFlowOutlook(
      tenantId,
      { from: '2026-10-01', to: '2026-12-31' },
      'month',
    )
    expect(outlook.buckets).toHaveLength(3)
    expect(outlook.buckets[0]).toMatchObject({
      startsOn: '2026-10-01',
      committedIn: '30000',
      forecastIn: '50000',
      net: '80000',
    })
    expect(outlook.buckets[1]).toMatchObject({ startsOn: '2026-11-01', forecastIn: '70000' })
    // A quiet month is present and empty, not missing.
    expect(outlook.buckets[2]).toMatchObject({ startsOn: '2026-12-01', net: '0' })
    // The two kinds are totalled apart and never merged into one figure.
    expect(outlook).toMatchObject({ committedIn: '30000', forecastIn: '120000', net: '150000' })
  })

  it('reports what fell due before the range rather than losing it', async () => {
    const { tenantId, context, terms } = await workspace()
    const late = value<{ id: string }>(
      await new DraftTitleUseCase(database, clock, 'receivable').execute({
        context: context(),
        terms: { ...terms, installments: [{ dueOn: '2026-09-01', amount: '4000' }] },
      }),
    ).id
    value(
      await new PostTitleUseCase(database, clock, 'receivable').execute({
        context: context(),
        titleId: late,
      }),
    )
    const outlook = await database.cashFlowOutlook(
      tenantId,
      { from: '2026-10-01', to: '2026-10-31' },
      'month',
    )
    expect(outlook).toMatchObject({ overdueIn: '4000', committedIn: '0' })
  })
})

describe('following sales and parties', () => {
  it('raises one forecast per confirmed order and withdraws it when the order is cancelled', async () => {
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
    const list = (view: 'draft' | 'forecast' | 'all' | 'closed') =>
      database.listTitles(tenantId, 'receivable', {
        view,
        today: '2026-09-16',
        limit: 50,
        offset: 0,
      })
    const forecasts = await list('forecast')
    expect(forecasts.data).toEqual([
      expect.objectContaining({
        origin: { type: 'sales-order', documentId: orderId },
        issuedOn: '2026-09-15',
        total: '2500',
        stage: 'forecast',
        documentNumber: `SO-${orderId.slice(-8).toUpperCase()}`,
      }),
    ])
    // A confirmed order is not yet a claim on anyone, so it is in neither of these.
    expect((await list('draft')).total).toBe(0)
    expect((await list('all')).total).toBe(0)
    const summary = await database.titlesSummary(tenantId, 'receivable', '2026-09-16')
    expect(summary).toMatchObject({
      drafts: 0,
      forecasts: 1,
      expected: [{ currency: 'BRL', total: '2500' }],
    })

    await deliver(tenantId, 'sales.order.cancelled', {
      orderId,
      orderVersion: 3,
      reservationId: null,
      cancelledAt: '2026-09-16T10:00:00.000Z',
      reason: null,
    })
    expect(
      (
        await database.listTitles(tenantId, 'receivable', {
          view: 'closed',
          today: '2026-09-16',
          limit: 50,
          offset: 0,
        })
      ).total,
    ).toBe(1)
  })

  it('expects the money on the schedule the customer agreed to', async () => {
    const { tenantId, partyId } = await workspace()
    const orderId = randomUUID()
    // The order was issued on the 14th and confirmed on the 15th; the terms are 0/30/60
    // from issue, so the first instalment already fell due before Financial heard of it.
    await deliver(tenantId, 'sales.order.confirmed', {
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
      installments: [
        { number: 1, dueOn: '2026-09-14', amount: { amount: '834', currency: 'BRL' } },
        { number: 2, dueOn: '2026-10-14', amount: { amount: '833', currency: 'BRL' } },
        { number: 3, dueOn: '2026-11-13', amount: { amount: '833', currency: 'BRL' } },
      ],
    })
    const [forecast] = (
      await database.listTitles(tenantId, 'receivable', {
        view: 'forecast',
        today: '2026-09-16',
        limit: 50,
        offset: 0,
      })
    ).data
    expect(forecast).toMatchObject({ total: '2500', stage: 'forecast', issuedOn: '2026-09-14' })
    const detail = await database.titleDetail(
      tenantId,
      'receivable',
      String(forecast?.id),
      '2026-09-16',
    )
    expect(detail?.installments).toMatchObject([
      { number: 1, dueOn: '2026-09-14', amount: '834' },
      { number: 2, dueOn: '2026-10-14', amount: '833' },
      { number: 3, dueOn: '2026-11-13', amount: '833' },
    ])
  })

  it('turns the forecast into an effective receivable when the order is invoiced', async () => {
    const { tenantId, partyId } = await workspace()
    const orderId = randomUUID()
    const line = {
      lineId: randomUUID(),
      itemId: randomUUID(),
      quantity: '2',
      description: 'Coffee',
      unitPrice: { amount: '1250', currency: 'BRL' },
      lineTotal: { amount: '2500', currency: 'BRL' },
    }
    await deliver(tenantId, 'sales.order.confirmed', {
      orderId,
      orderVersion: 2,
      customerId: partyId,
      reservationId: randomUUID(),
      confirmedAt: '2026-09-15T21:30:00.000Z',
      lines: [line],
      total: { amount: '2500', currency: 'BRL' },
    })
    const invoicing = {
      orderId,
      orderVersion: 3,
      customerId: partyId,
      confirmedAt: '2026-09-15T21:30:00.000Z',
      lines: [line],
      total: { amount: '2700', currency: 'BRL' },
    }
    const eventId = randomUUID()
    await deliver(tenantId, 'sales.invoicing.requested', invoicing, eventId)
    await deliver(tenantId, 'sales.invoicing.requested', invoicing, eventId)
    await deliver(tenantId, 'sales.invoicing.requested', invoicing)

    const list = (view: 'draft' | 'forecast') =>
      database.listTitles(tenantId, 'receivable', {
        view,
        today: '2026-09-16',
        limit: 50,
        offset: 0,
      })
    // The same title changed stage: there is one, not a forecast beside a receivable.
    expect((await list('forecast')).total).toBe(0)
    const drafts = await list('draft')
    expect(drafts.total).toBe(1)
    // The invoice differed from the order, and its total is what is now owed.
    expect(drafts.data[0]).toMatchObject({ stage: 'effective', total: '2700' })
    expect(await database.titlesSummary(tenantId, 'receivable', '2026-09-16')).toMatchObject({
      drafts: 1,
      forecasts: 0,
      expected: [],
    })
  })

  it('ends with one effective receivable whichever of the two events arrives first', async () => {
    const line = {
      lineId: randomUUID(),
      itemId: randomUUID(),
      quantity: '1',
      description: 'Coffee',
      unitPrice: { amount: '900', currency: 'BRL' },
      lineTotal: { amount: '900', currency: 'BRL' },
    }
    // Sales emits both from the same operation, so either can be handled first.
    const play = async (order: readonly ('confirmed' | 'invoicing')[]) => {
      const { tenantId, partyId } = await workspace()
      const orderId = randomUUID()
      const shared = {
        orderId,
        orderVersion: 2,
        customerId: partyId,
        confirmedAt: '2026-09-15T21:30:00.000Z',
        lines: [line],
        total: { amount: '900', currency: 'BRL' },
      }
      for (const step of order)
        await deliver(
          tenantId,
          step === 'confirmed' ? 'sales.order.confirmed' : 'sales.invoicing.requested',
          step === 'confirmed' ? { ...shared, reservationId: randomUUID() } : shared,
        )
      const drafts = await database.listTitles(tenantId, 'receivable', {
        view: 'draft',
        today: '2026-09-16',
        limit: 50,
        offset: 0,
      })
      return { drafts, tenantId }
    }
    for (const order of [
      ['confirmed', 'invoicing'],
      ['invoicing', 'confirmed'],
    ] as const) {
      const { drafts, tenantId } = await play(order)
      expect(drafts.total).toBe(1)
      expect(drafts.data[0]).toMatchObject({ stage: 'effective', total: '900' })
      expect(await database.titlesSummary(tenantId, 'receivable', '2026-09-16')).toMatchObject({
        forecasts: 0,
      })
    }
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
    expect(await database.listCounterparties(tenantId, 'customer')).toEqual([])
    expect(
      (
        await new DraftTitleUseCase(database, clock, 'receivable').execute({
          context: context(),
          terms,
        })
      ).isLeft(),
    ).toBe(true)
  })
})
