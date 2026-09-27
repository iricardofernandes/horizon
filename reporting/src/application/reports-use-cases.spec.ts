import {
  EMPTY,
  FakeOwners,
  InMemoryCommands,
  InMemoryReports,
} from 'test/repositories/in-memory-reports'
import { describe, expect, it } from 'vitest'
import { NO_FILTER } from '@/domain/reports'
import { ownerFigures, UnreadableOwnerReport } from './owner-figures'
import { reportedFigures } from './report-data'
import { ManageSavedFiltersUseCase } from './use-cases/manage-saved-filters'
import { DashboardUseCase, ReadReportUseCase } from './use-cases/read-report'
import { RunReconciliationUseCase } from './use-cases/run-reconciliation'

const now = new Date('2026-09-27T12:00:00Z')
const clock = { now: () => now }
const cutoff = new Date('2026-09-27T11:00:00Z')
const tenantId = '0196a1b2-0000-7000-8000-0000000000aa'
const context = { tenantId, actor: 'analyst-1', requestId: null }
const idempotent = () => ({ ...context, idempotencyKey: `reconcile-${crypto.randomUUID()}` })

const cash = {
  receivables: [{ currency: 'BRL', outstanding: '1500' }],
  payables: [{ currency: 'BRL', outstanding: '700' }],
  accounts: [{ accountId: 'acc-1', currency: 'BRL', balance: '9000' }],
}

function setup() {
  const reports = new InMemoryReports()
  reports.data = { ...EMPTY, 'cash-position': cash }
  reports.watermarkAll = new Date('2026-09-27T11:30:00Z')
  const owners = new FakeOwners(reports)
  owners.answers.set('/financial/receivables/summary', {
    status: 'ok',
    body: { currencies: [{ currency: 'BRL', outstanding: '1500' }] },
  })
  owners.answers.set('/financial/payables/summary', {
    status: 'ok',
    body: { currencies: [{ currency: 'BRL', outstanding: '700' }] },
  })
  owners.answers.set('/treasury/accounts', {
    status: 'ok',
    body: { data: [{ id: 'acc-1', projectedBalance: '9000' }] },
  })
  const commands = new InMemoryCommands(reports)
  const reconcile = new RunReconciliationUseCase(reports, owners, commands, clock)
  return { reports, owners, commands, reconcile }
}

describe('reading a report', () => {
  it('says its cutoff, which sources are settled through it, and its checks', async () => {
    const { reports } = setup()
    const answer = await new ReadReportUseCase(reports, clock).execute({
      tenantId,
      name: 'cash-position',
      cutoff,
      filter: NO_FILTER,
    })
    expect(answer.value).toMatchObject({
      report: 'cash-position',
      cutoff,
      settled: true,
      sources: [
        { source: 'financial', settled: true },
        { source: 'treasury', settled: true },
      ],
      data: cash,
      reconciliation: null,
    })
    const later = await new ReadReportUseCase(reports, clock).execute({
      tenantId,
      name: 'cash-position',
      cutoff: null,
      filter: NO_FILTER,
    })
    expect(later.value).toMatchObject({ cutoff: now, settled: false })
    const future = await new ReadReportUseCase(reports, clock).execute({
      tenantId,
      name: 'cash-position',
      cutoff: new Date('2026-09-28T00:00:00Z'),
      filter: NO_FILTER,
    })
    expect(future.isLeft()).toBe(true)
  })

  it('gives every headline at one cutoff on the dashboard', async () => {
    const { reports } = setup()
    reports.data = {
      ...reports.data,
      'pipeline-to-revenue': {
        months: [
          {
            month: '2026-09',
            currency: 'BRL',
            won: { count: 1, value: '500' },
            lost: { count: 0, value: '0' },
            converted: { count: 0, value: '0' },
          },
          {
            month: '2026-08',
            currency: 'BRL',
            won: { count: 4, value: '900' },
            lost: { count: 0, value: '0' },
            converted: { count: 0, value: '0' },
          },
        ],
        quotesAccepted: [],
      },
    }
    const answer = await new DashboardUseCase(reports, clock).execute({ tenantId, cutoff })
    expect(answer.value).toMatchObject({
      cutoff,
      reports: {
        'cash-position': { settled: true, headline: { receivables: cash.receivables } },
        'pipeline-to-revenue': {
          headline: { month: '2026-09', won: [{ currency: 'BRL', won: { count: 1 } }] },
        },
      },
    })
    expect(reports.requested.every((request) => request.filter === NO_FILTER)).toBe(true)
    expect(
      (await new DashboardUseCase(reports, clock).execute({ tenantId, cutoff: now })).isRight(),
    ).toBe(true)
    expect(
      (
        await new DashboardUseCase(reports, clock).execute({
          tenantId,
          cutoff: new Date('2027-01-01T00:00:00Z'),
        })
      ).isLeft(),
    ).toBe(true)
  })
})

describe('reconciling a report', () => {
  it('matches every check against its owner, and keeps the run', async () => {
    const { reports, owners, reconcile } = setup()
    const run = await reconcile.execute({
      context: idempotent(),
      name: 'cash-position',
      cutoff,
      bearer: 'token',
    })
    expect(run.value).toMatchObject({ outcome: 'matched', report: 'cash-position', cutoff })
    expect(owners.calls.map((call) => call.bearer)).toEqual(['token', 'token', 'token'])
    expect(reports.runs).toHaveLength(1)
    expect(reports.audit).toEqual(['reconciliation.run'])
    const read = await new ReadReportUseCase(reports, clock).execute({
      tenantId,
      name: 'cash-position',
      cutoff,
      filter: NO_FILTER,
    })
    expect(read.value).toMatchObject({ reconciliation: { outcome: 'matched' } })
  })

  it('keeps every difference, and says why a check could not be made', async () => {
    const { owners, reconcile } = setup()
    owners.answers.set('/financial/payables/summary', {
      status: 'ok',
      body: { currencies: [{ currency: 'BRL', outstanding: '650' }] },
    })
    owners.answers.set('/treasury/accounts', { status: 'forbidden' })
    const run = await reconcile.execute({
      context: idempotent(),
      name: 'cash-position',
      cutoff,
      bearer: 'token',
    })
    expect(run.value).toMatchObject({
      outcome: 'different',
      checks: [
        { check: 'receivables-outstanding', outcome: 'matched' },
        {
          check: 'payables-outstanding',
          outcome: 'different',
          differences: [{ key: 'BRL', reported: '700', owner: '650' }],
        },
        { check: 'account-balances', outcome: 'not-comparable', reason: 'forbidden' },
      ],
    })
  })

  it('does not compare with an owner that moved after the cutoff, before or while reading', async () => {
    const { reports, reconcile } = setup()
    reports.moved.add('treasury')
    reports.movingOnRead.add('financial')
    const run = await reconcile.execute({
      context: idempotent(),
      name: 'cash-position',
      cutoff,
      bearer: 'token',
    })
    expect(run.value).toMatchObject({
      outcome: 'not-comparable',
      checks: [
        { check: 'receivables-outstanding', reason: 'moved-after-cutoff' },
        { check: 'payables-outstanding', reason: 'moved-after-cutoff' },
        { check: 'account-balances', reason: 'moved-after-cutoff' },
      ],
    })
  })

  it('treats an owner that is down, or answers what its contract would not, as unavailable', async () => {
    const { owners, reconcile } = setup()
    owners.answers.set('/financial/payables/summary', { status: 'ok', body: { nope: true } })
    owners.answers.delete('/treasury/accounts')
    const run = await reconcile.execute({
      context: idempotent(),
      name: 'cash-position',
      cutoff,
      bearer: 'token',
    })
    expect(run.value).toMatchObject({
      outcome: 'not-comparable',
      checks: [
        { outcome: 'matched' },
        { check: 'payables-outstanding', reason: 'owner-unavailable' },
        { check: 'account-balances', reason: 'owner-unavailable' },
      ],
    })
  })

  it('always compares with an owner that answers as of the cutoff, and asks it for that cutoff', async () => {
    const { reports, owners, reconcile } = setup()
    reports.moved.add('crm')
    reports.data = {
      ...reports.data,
      'pipeline-to-revenue': {
        months: [
          {
            month: '2026-09',
            currency: 'BRL',
            won: { count: 2, value: '800' },
            lost: { count: 1, value: '100' },
            converted: { count: 1, value: '300' },
          },
        ],
        quotesAccepted: [],
      },
    }
    owners.answers.set('/crm/forecast', {
      status: 'ok',
      body: {
        data: [
          { month: '2026-09', currency: 'BRL', wonCount: 1, wonValue: '500' },
          { month: '2026-09', currency: 'BRL', wonCount: 1, wonValue: '300' },
          { month: '2026-10', currency: 'BRL', wonCount: 0, wonValue: '0' },
        ],
      },
    })
    const run = await reconcile.execute({
      context: idempotent(),
      name: 'pipeline-to-revenue',
      cutoff,
      bearer: 'token',
    })
    expect(run.value).toMatchObject({ outcome: 'matched' })
    expect(owners.calls.at(-1)?.query).toEqual({
      cutoff: cutoff.toISOString(),
      groupBy: 'pipeline',
    })
  })

  it('refuses a cutoff that is not settled, and one in the future', async () => {
    const { reports, reconcile } = setup()
    reports.watermarkAll = new Date('2026-09-27T10:00:00Z')
    const unsettled = await reconcile.execute({
      context: idempotent(),
      name: 'cash-position',
      cutoff,
      bearer: 'token',
    })
    expect(unsettled.value).toMatchObject({ title: 'Conflict' })
    const future = await reconcile.execute({
      context: idempotent(),
      name: 'cash-position',
      cutoff: new Date('2027-01-01T00:00:00Z'),
      bearer: 'token',
    })
    expect(future.isLeft()).toBe(true)
    expect(reports.runs).toHaveLength(0)
  })
})

describe('owner and reported figures', () => {
  it('reads each owner report into the keys the report uses', () => {
    expect(
      ownerFigures('orders-committed', {
        data: [
          { status: 'approved', currency: 'BRL', count: 2, total: '300' },
          { status: 'closed', currency: 'BRL', count: 1, total: '100' },
          { status: 'cancelled', currency: 'BRL', count: 5, total: '999' },
          { status: 'draft', currency: 'USD', count: 1, total: '5' },
        ],
      }),
    ).toEqual({ 'BRL:count': '3', 'BRL:total': '400' })
    expect(
      ownerFigures('orders-confirmed', {
        data: [
          { status: 'confirmed', currency: 'BRL', count: 1, total: '3125' },
          { status: 'placed', currency: 'BRL', count: 1, total: '0' },
        ],
      }),
    ).toEqual({ 'BRL:count': '1', 'BRL:total': '3125' })
    expect(() => ownerFigures('won-by-month', { data: 'nope' })).toThrow(UnreadableOwnerReport)
    expect(() => ownerFigures('account-balances', {})).toThrow(UnreadableOwnerReport)
    expect(() => ownerFigures('orders-confirmed', null)).toThrow(UnreadableOwnerReport)
  })

  it('reads each report into the same keys', () => {
    const flow = { raised: '0', settled: '0', open: '0' }
    expect(
      reportedFigures('orders-confirmed', {
        currencies: [
          {
            currency: 'BRL',
            confirmed: { count: 1, total: '3125' },
            cancelledAfterConfirmation: 0,
            shipped: '0',
            returned: '0',
            receivables: flow,
            bankReconciled: '0',
          },
        ],
      }),
    ).toEqual({ 'BRL:count': '1', 'BRL:total': '3125' })
    expect(
      reportedFigures('orders-committed', {
        currencies: [
          {
            currency: 'USD',
            committed: { count: 2, total: '10' },
            cancelledAfterApproval: 1,
            received: '0',
            returns: 0,
            payables: flow,
          },
        ],
      }),
    ).toEqual({ 'USD:count': '2', 'USD:total': '10' })
    expect(reportedFigures('account-balances', cash)).toEqual({ 'acc-1': '9000' })
  })
})

describe('saved filters', () => {
  it('saves a private filter, shares only as an administrator, and lets its owner change it', async () => {
    const { reports, commands } = setup()
    const filters = new ManageSavedFiltersUseCase(commands, clock)
    const saved = await filters.create(
      { ...context, idempotencyKey: 'filter-key-1' },
      { share: false },
      { report: 'order-to-cash', name: ' Reais ', filter: { currency: 'BRL' }, shared: false },
    )
    expect(saved.value).toMatchObject({ name: 'Reais', ownerId: 'analyst-1', shared: false })
    const again = await filters.create(
      { ...context, idempotencyKey: 'filter-key-1' },
      { share: false },
      { report: 'order-to-cash', name: ' Reais ', filter: { currency: 'BRL' }, shared: false },
    )
    expect(again.value).toEqual(saved.value)
    expect(
      (
        await filters.create(
          { ...context, idempotencyKey: 'filter-key-2' },
          { share: false },
          { report: 'order-to-cash', name: 'All', filter: {}, shared: true },
        )
      ).isLeft(),
    ).toBe(true)
    for (const bad of [
      { name: '', filter: {} },
      { name: 'ok', filter: { from: '2026-13' } },
    ])
      expect(
        (
          await filters.create(
            { ...context, idempotencyKey: `filter-bad-${bad.name}` },
            { share: false },
            { report: 'order-to-cash', shared: false, ...bad },
          )
        ).isLeft(),
      ).toBe(true)

    const filterId = (saved.value as { filterId: string }).filterId
    const renamed = await filters.update(context, { share: false }, filterId, {
      name: 'Só reais',
      filter: { currency: 'BRL', from: '2026-01' },
    })
    expect(renamed.value).toMatchObject({ name: 'Só reais', filter: { from: '2026-01' } })
    expect(
      (await filters.update(context, { share: false }, filterId, { shared: true })).isLeft(),
    ).toBe(true)
    expect((await filters.update(context, { share: false }, filterId, { name: '' })).isLeft()).toBe(
      true,
    )
    expect(
      (await filters.update(context, { share: false }, filterId, { filter: { to: 'x' } })).isLeft(),
    ).toBe(true)
    const stranger = { ...context, actor: 'someone-else' }
    expect(
      (await filters.update(stranger, { share: true }, filterId, { name: 'x' })).isLeft(),
    ).toBe(true)
    expect((await filters.remove(stranger, { share: true }, filterId)).isLeft()).toBe(true)
    expect((await filters.remove(context, { share: false }, filterId)).value).toEqual({ filterId })
    expect(reports.filters).toHaveLength(0)
    expect(reports.audit).toEqual([
      'saved-filter.created',
      'saved-filter.changed',
      'saved-filter.removed',
    ])
  })

  it('lets an administrator change or remove a shared filter someone else saved', async () => {
    const { reports, commands } = setup()
    const filters = new ManageSavedFiltersUseCase(commands, clock)
    const saved = await filters.create(
      { ...context, idempotencyKey: 'shared-key-1' },
      { share: true },
      { report: 'cash-position', name: 'Caixa', filter: {}, shared: true },
    )
    const filterId = (saved.value as { filterId: string }).filterId
    const admin = { ...context, actor: 'admin-2' }
    expect(
      (await filters.update(admin, { share: true }, filterId, { shared: false })).isRight(),
    ).toBe(true)
    expect(reports.filters[0]?.shared).toBe(false)
    expect((await filters.remove(admin, { share: true }, filterId)).isLeft()).toBe(true)
  })
})
