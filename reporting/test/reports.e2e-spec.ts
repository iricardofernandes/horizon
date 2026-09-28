import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { FakeOwners } from 'test/repositories/in-memory-reports'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApplySealUseCase } from '@/application/use-cases/apply-seal'
import { JournalEventUseCase } from '@/application/use-cases/journal-event'
import { ManageSavedFiltersUseCase } from '@/application/use-cases/manage-saved-filters'
import { ReadReportUseCase } from '@/application/use-cases/read-report'
import { RunReconciliationUseCase } from '@/application/use-cases/run-reconciliation'
import { NO_FILTER, type ReportFilter, type ReportName } from '@/domain/reports'
import { auditHash, ReportingDatabase } from '@/infrastructure/database/drizzle/reporting-database'

/**
 * The four reports as queries over the real journal (Phase 62): the order of facts is
 * when they occurred, whatever order they arrived in.
 */
const clock = { now: () => new Date() }
let database: ReportingDatabase
let journal: JournalEventUseCase
let administrator: ReturnType<typeof postgres>
let application: ReturnType<typeof postgres>

beforeAll(() => {
  database = new ReportingDatabase({ url: process.env.DATABASE_URL ?? '' })
  journal = new JournalEventUseCase(database)
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end(), application?.end()])
})

const base = Date.parse('2026-09-10T12:00:00Z')
const at = (minutes: number) => new Date(base + minutes * 60_000)
const money = (amount: string, currency = 'BRL') => ({ amount, currency })

/** Records facts in the order given, each at its own minute. */
async function record(tenantId: string, facts: readonly [number, string, object][]) {
  for (const [minute, eventType, payload] of facts)
    await journal.execute(
      {
        eventId: randomUUID(),
        tenantId,
        eventType,
        eventVersion: 1,
        occurredAt: at(minute).toISOString(),
        traceId: 'c'.repeat(32),
        payload,
      },
      'replay',
    )
}

function read<N extends ReportName>(
  tenantId: string,
  name: N,
  cutoff: Date,
  filter: ReportFilter = NO_FILTER,
) {
  return database.reports.report(tenantId, name, cutoff, filter)
}

describe('cash position', () => {
  it('keeps what is still open after the latest settlement fact, and each account balance', async () => {
    const tenantId = randomUUID()
    const receivable = randomUUID()
    const payable = randomUUID()
    const account = randomUUID()
    const second = randomUUID()
    // Arrival order is shuffled; occurrence order is what counts.
    await record(tenantId, [
      [
        30,
        'financial.settlement.reversed',
        { titleId: receivable, settlementId: second, outstanding: money('600') },
      ],
      [
        10,
        'financial.receivable.posted',
        { titleId: receivable, total: money('1000'), origin: { type: 'manual' } },
      ],
      [
        20,
        'financial.settlement.recorded',
        {
          titleId: receivable,
          settlementId: randomUUID(),
          received: money('400'),
          outstanding: money('600'),
        },
      ],
      [
        25,
        'financial.settlement.recorded',
        {
          titleId: receivable,
          settlementId: second,
          received: money('600'),
          outstanding: money('0'),
        },
      ],
      [
        11,
        'financial.payable.posted',
        { titleId: payable, total: money('300'), origin: { type: 'manual' } },
      ],
      [12, 'financial.payable.reversed', { titleId: payable }],
      [1, 'treasury.account.opened', { accountId: account, currency: 'BRL' }],
      [
        2,
        'treasury.entry.recorded',
        { accountId: account, direction: 'inflow', amount: money('500') },
      ],
      [
        40,
        'treasury.entry.recorded',
        { accountId: account, direction: 'outflow', amount: money('200') },
      ],
    ])

    expect(await read(tenantId, 'cash-position', at(50))).toEqual({
      receivables: [{ currency: 'BRL', outstanding: '600' }],
      payables: [],
      accounts: [{ accountId: account, currency: 'BRL', balance: '300' }],
    })
    // Before the second settlement was undone, and before the outflow.
    expect(await read(tenantId, 'cash-position', at(27))).toEqual({
      receivables: [],
      payables: [],
      accounts: [{ accountId: account, currency: 'BRL', balance: '500' }],
    })
    expect(
      await read(tenantId, 'cash-position', at(50), { currency: 'USD', from: null, to: null }),
    ).toEqual({ receivables: [], payables: [], accounts: [] })
  })
})

describe('order to cash and procure to pay', () => {
  it('follows orders to their latest decision, shipments, receivables and the bank', async () => {
    const tenantId = randomUUID()
    const [kept, cancelled, title, reconciliation, undone] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ]
    await record(tenantId, [
      [1, 'sales.order.confirmed', { orderId: kept, total: money('2500') }],
      [2, 'sales.order.confirmed', { orderId: cancelled, total: money('900') }],
      [3, 'sales.order.cancelled', { orderId: cancelled }],
      [4, 'sales.order.cancelled', { orderId: randomUUID() }],
      [5, 'sales.shipment.dispatched', { orderId: kept, value: money('2500') }],
      [6, 'sales.shipment.returned', { orderId: kept, value: money('500') }],
      [
        7,
        'financial.receivable.posted',
        {
          titleId: title,
          total: money('2000'),
          origin: { type: 'sales-shipment', documentId: kept },
        },
      ],
      [
        8,
        'financial.settlement.recorded',
        {
          titleId: title,
          settlementId: randomUUID(),
          received: money('1200'),
          outstanding: money('800'),
        },
      ],
      [
        9,
        'treasury.reconciliation.confirmed',
        { reconciliationId: reconciliation, amount: money('1200') },
      ],
      [10, 'treasury.reconciliation.confirmed', { reconciliationId: undone, amount: money('50') }],
      [11, 'treasury.reconciliation.undone', { reconciliationId: undone }],
    ])
    expect(await read(tenantId, 'order-to-cash', at(20))).toEqual({
      currencies: [
        {
          currency: 'BRL',
          confirmed: { count: 1, total: '2500' },
          cancelledAfterConfirmation: 1,
          shipped: '2500',
          returned: '500',
          receivables: { raised: '2000', settled: '1200', open: '800' },
          bankReconciled: '1200',
        },
      ],
    })
    // The months narrow flows, never positions.
    const narrowed = await read(tenantId, 'order-to-cash', at(20), {
      currency: null,
      from: '2026-10',
      to: null,
    })
    expect(narrowed.currencies[0]).toMatchObject({
      confirmed: { count: 1, total: '2500' },
      shipped: '0',
      receivables: { raised: '0', settled: '0', open: '800' },
    })
  })

  it('keeps an order committed at its latest approved total, and payables from purchasing', async () => {
    const tenantId = randomUUID()
    const [order, dropped, receipt, title] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ]
    await record(tenantId, [
      [1, 'procurement.order.approved', { orderId: order, total: money('1000') }],
      [2, 'procurement.order.approved', { orderId: order, total: money('1200') }],
      [3, 'procurement.order.approved', { orderId: dropped, total: money('400') }],
      [4, 'procurement.order.cancelled', { orderId: dropped, wasApproved: true }],
      [
        5,
        'procurement.receipt.recorded',
        { orderId: order, receiptId: receipt, value: money('1200'), supplierName: 'Maria' },
      ],
      [6, 'procurement.receipt.returned', { orderId: order, receiptId: receipt }],
      [
        7,
        'financial.payable.posted',
        {
          titleId: title,
          total: money('1200'),
          origin: { type: 'purchase-receipt', documentId: receipt },
        },
      ],
      [
        8,
        'financial.settlement.recorded',
        {
          titleId: title,
          settlementId: randomUUID(),
          received: money('1200'),
          outstanding: money('0'),
        },
      ],
    ])
    expect(await read(tenantId, 'procure-to-pay', at(20))).toEqual({
      currencies: [
        {
          currency: 'BRL',
          committed: { count: 1, total: '1200' },
          cancelledAfterApproval: 1,
          received: '1200',
          returns: 1,
          payables: { raised: '1200', settled: '1200', open: '0' },
        },
      ],
    })
  })
})

describe('pipeline to revenue', () => {
  it('counts each opportunity by its latest outcome, in the month it closed', async () => {
    const tenantId = randomUUID()
    const [won, reopened, lost] = [randomUUID(), randomUUID(), randomUUID()]
    await record(tenantId, [
      [
        1,
        'crm.opportunity.won',
        { opportunityId: won, value: money('500'), closedOn: '2026-09-10' },
      ],
      [
        2,
        'crm.opportunity.converted',
        { opportunityId: won, value: money('500'), closedOn: '2026-09-10' },
      ],
      [
        3,
        'crm.opportunity.won',
        { opportunityId: reopened, value: money('700'), closedOn: '2026-09-10' },
      ],
      [4, 'crm.opportunity.reopened', { opportunityId: reopened }],
      [
        5,
        'crm.opportunity.lost',
        { opportunityId: lost, value: money('200'), closedOn: '2026-08-31' },
      ],
      [
        6,
        'sales.quote.accepted',
        {
          quoteId: randomUUID(),
          total: money('500'),
          attribution: { ownerId: 'x', sourceId: null },
        },
      ],
      [
        7,
        'sales.quote.accepted',
        { quoteId: randomUUID(), total: money('999'), attribution: null },
      ],
    ])
    expect(await read(tenantId, 'pipeline-to-revenue', at(20))).toEqual({
      months: [
        {
          month: '2026-08',
          currency: 'BRL',
          won: { count: 0, value: '0' },
          lost: { count: 1, value: '200' },
          converted: { count: 0, value: '0' },
        },
        {
          month: '2026-09',
          currency: 'BRL',
          won: { count: 1, value: '500' },
          lost: { count: 0, value: '0' },
          converted: { count: 1, value: '500' },
        },
      ],
      quotesAccepted: [{ currency: 'BRL', count: 1, total: '500' }],
    })
    // Before it was reopened, the second one was won too.
    const earlier = await read(tenantId, 'pipeline-to-revenue', at(3))
    expect(earlier.months).toEqual([
      expect.objectContaining({ month: '2026-09', won: { count: 2, value: '1200' } }),
    ])
  })
})

describe('settled cutoffs and reconciliation runs', () => {
  it('never changes a settled cutoff when a later fact arrives, and stores the run it was proven by', async () => {
    const tenantId = randomUUID()
    const sealer = new ApplySealUseCase(database, clock)
    const title = randomUUID()
    await record(tenantId, [
      [
        1,
        'financial.receivable.posted',
        { titleId: title, total: money('1000'), origin: { type: 'manual' } },
      ],
    ])
    for (const [source, count] of [
      ['financial', 1],
      ['treasury', 0],
    ] as const)
      expect(
        await sealer.execute({
          sealId: randomUUID(),
          source,
          tenantId,
          through: at(5),
          count,
          sealedAt: at(6),
        }),
      ).toMatchObject({ outcome: 'matched' })
    const report = new ReadReportUseCase(database.reports, clock)
    const before = await report.execute({
      tenantId,
      name: 'cash-position',
      cutoff: at(5),
      filter: NO_FILTER,
    })
    expect(before.value).toMatchObject({
      settled: true,
      data: { receivables: [{ currency: 'BRL', outstanding: '1000' }] },
    })

    await record(tenantId, [
      [
        10,
        'financial.settlement.recorded',
        {
          titleId: title,
          settlementId: randomUUID(),
          received: money('1000'),
          outstanding: money('0'),
        },
      ],
    ])
    const after = await report.execute({
      tenantId,
      name: 'cash-position',
      cutoff: at(5),
      filter: NO_FILTER,
    })
    expect((after.value as { data: object }).data).toEqual((before.value as { data: object }).data)
    expect(await database.reports.movedAfter(tenantId, 'financial', at(5))).toBe(true)

    // The owner is read with the caller's token; financial moved after the cutoff.
    const owners = new FakeOwners()
    owners.answers.set('/treasury/accounts', { status: 'ok', body: { data: [] } })
    const runs = new RunReconciliationUseCase(database.reports, owners, database.commands, clock)
    const run = await runs.execute({
      context: {
        tenantId,
        actor: 'analyst',
        requestId: null,
        idempotencyKey: `run-${randomUUID()}`,
      },
      name: 'cash-position',
      cutoff: at(5),
      bearer: 'caller-token',
    })
    expect(run.value).toMatchObject({
      outcome: 'not-comparable',
      checks: [
        { check: 'receivables-outstanding', reason: 'moved-after-cutoff' },
        { check: 'payables-outstanding', reason: 'moved-after-cutoff' },
        { check: 'account-balances', outcome: 'matched' },
      ],
    })
    expect(owners.calls).toEqual([
      { path: '/treasury/accounts', query: {}, bearer: 'caller-token' },
    ])
    const latest = await report.execute({
      tenantId,
      name: 'cash-position',
      cutoff: at(5),
      filter: NO_FILTER,
    })
    expect(latest.value).toMatchObject({ reconciliation: { outcome: 'not-comparable' } })

    // The run and its audit link are history.
    const [link] = await administrator`
      select sequence, previous_hash, hash, actor, subject_type, subject_id, action, occurred_at,
        request_id, trace_id, details, tenant_id
      from audit_log where tenant_id = ${tenantId}`
    expect(link).toMatchObject({ action: 'reconciliation.run', actor: 'analyst' })
    expect(link?.hash).toBe(
      auditHash(String(link?.previous_hash), {
        sequence: Number(link?.sequence),
        tenantId,
        actor: link?.actor,
        subjectType: link?.subject_type,
        subjectId: link?.subject_id,
        action: link?.action,
        occurredAt: link?.occurred_at,
        requestId: link?.request_id,
        traceId: link?.trace_id,
        details: link?.details,
      }),
    )
    await expect(administrator`delete from reconciliation_runs`).rejects.toThrow(/append-only/)
    await expect(administrator`update audit_log set actor = 'x'`).rejects.toThrow(/append-only/)
    // Phase 68: the audit read endpoint judges each page, and a tampered row shows.
    expect((await database.auditPage(tenantId, { limit: 50 })).chain.status).toBe('intact')
    await administrator.begin(async (tx) => {
      await tx`set local session_replication_role = replica`
      await tx`update audit_log set actor = 'someone else' where tenant_id = ${tenantId} and action = 'reconciliation.run'`
    })
    expect((await database.auditPage(tenantId, { limit: 50 })).chain).toMatchObject({
      status: 'broken',
      broken: [Number(link?.sequence)],
    })
  })
})

describe('saved filters', () => {
  it("keeps a person's filters to themselves unless shared, and never across tenants", async () => {
    const tenantId = randomUUID()
    const filters = new ManageSavedFiltersUseCase(database.commands, clock)
    const context = { tenantId, actor: 'analyst-1', requestId: null }
    const mine = await filters.create(
      { ...context, idempotencyKey: `filter-${randomUUID()}` },
      { share: false },
      { report: 'order-to-cash', name: 'Reais', filter: { currency: 'BRL' }, shared: false },
    )
    await filters.create(
      { ...context, actor: 'admin-1', idempotencyKey: `filter-${randomUUID()}` },
      { share: true },
      { report: 'cash-position', name: 'Caixa', filter: {}, shared: true },
    )
    const names = async (tenant: string, user: string) =>
      (await database.reports.listFilters(tenant, user, null)).map((filter) => filter.name)
    expect(await names(tenantId, 'analyst-1')).toEqual(['Caixa', 'Reais'])
    expect(await names(tenantId, 'viewer-1')).toEqual(['Caixa'])
    expect(await names(randomUUID(), 'analyst-1')).toEqual([])

    const filterId = (mine.value as { filterId: string }).filterId
    expect(
      (await filters.update(context, { share: false }, filterId, { filter: { currency: 'USD' } }))
        .value,
    ).toMatchObject({ filter: { currency: 'USD', from: null, to: null } })
    expect((await filters.remove(context, { share: false }, filterId)).isRight()).toBe(true)
    expect(await names(tenantId, 'analyst-1')).toEqual(['Caixa'])

    const leaked = await application.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${randomUUID()}, true)`
      return tx`select
        (select count(*) from saved_filters where tenant_id = ${tenantId})::int as filters,
        (select count(*) from audit_log where tenant_id = ${tenantId})::int as audit`
    })
    expect(leaked[0]).toEqual({ filters: 0, audit: 0 })
  })
})
