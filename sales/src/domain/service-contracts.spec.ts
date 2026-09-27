import { randomUUID } from 'node:crypto'
import { snapshotOf } from 'test/support/snapshot-of'
import { ServiceContract } from './entities/service-contract'
import { type ContractLine, type Recurrence, readjusted } from './services/contract-schedule'
import {
  BusinessDate,
  Currency,
  LineDescription,
  Money,
  PaymentTerms,
  Quantity,
  Reason,
} from './value-objects/sales-values'

function unwrap<T>(result: { isLeft(): boolean; value: T }): T {
  if (result.isLeft()) throw result.value
  return result.value
}

const brl = unwrap(Currency.create('BRL'))
const day = (value: string) => unwrap(BusinessDate.create(value))
const now = new Date('2026-09-20T12:00:00.000Z')
const today = day('2026-09-20')
const reason = unwrap(Reason.create('Revisado com o cliente'))

function line(price: bigint, units = '1', name = 'Suporte mensal'): ContractLine {
  return {
    lineId: randomUUID(),
    itemId: randomUUID(),
    description: unwrap(LineDescription.create(name)),
    quantity: unwrap(Quantity.create(units)),
    unitPrice: Money.fromAmount(price, brl),
  }
}

function contract(
  options: {
    recurrence?: Recurrence
    startsOn?: string
    endsOn?: string | null
    autoRenew?: boolean
    lines?: ContractLine[]
  } = {},
) {
  const created = unwrap(
    ServiceContract.draft({
      tenantId: randomUUID(),
      customerId: randomUUID(),
      currency: brl,
      lines: options.lines ?? [line(100_000n)],
      recurrence: options.recurrence ?? 'monthly',
      startsOn: day(options.startsOn ?? '2026-09-01'),
      endsOn:
        options.endsOn === undefined
          ? day('2027-08-31')
          : options.endsOn
            ? day(options.endsOn)
            : null,
      billingDay: 5,
      autoRenew: options.autoRenew ?? false,
      paymentTerms: PaymentTerms.immediate(),
      sellerId: null,
      notes: null,
      createdBy: 'ana',
      now,
    }),
  )
  unwrap(created.activate(now))
  created.pullDomainEvents()
  return created
}

const whole = { from: day('2026-01-01'), to: day('2030-12-31') }

describe('contract schedule', () => {
  it('lays calendar periods from the start to the end, named by their first month', () => {
    const monthly = contract()
    const periods = monthly.schedule(whole)
    expect(periods).toHaveLength(12)
    expect(periods[0]).toMatchObject({ competence: '2026-09', revision: 1, billable: true })
    expect(periods[0]?.billingOn.value).toBe('2026-09-05')
    expect(periods[11]?.endsOn.value).toBe('2027-08-31')
    const quarterly = contract({ recurrence: 'quarterly', endsOn: null })
    const quarters = quarterly.schedule({ from: day('2026-09-01'), to: day('2027-08-31') })
    expect(quarters.map((period) => period.competence)).toEqual([
      '2026-09',
      '2026-12',
      '2027-03',
      '2027-06',
    ])
    expect(quarters[3]?.endsOn.value).toBe('2027-08-31')
  })

  it('refuses a start mid-month, an end mid-period and auto-renewal without an end', () => {
    const base = {
      tenantId: randomUUID(),
      customerId: randomUUID(),
      currency: brl,
      lines: [line(100n)],
      recurrence: 'quarterly' as const,
      billingDay: 5,
      autoRenew: false,
      paymentTerms: PaymentTerms.immediate(),
      sellerId: null,
      notes: null,
      createdBy: 'ana',
      now,
    }
    expect(
      ServiceContract.draft({ ...base, startsOn: day('2026-09-02'), endsOn: null }).isLeft(),
    ).toBe(true)
    expect(
      ServiceContract.draft({
        ...base,
        startsOn: day('2026-09-01'),
        endsOn: day('2026-10-31'),
      }).isLeft(),
    ).toBe(true)
    expect(
      ServiceContract.draft({
        ...base,
        startsOn: day('2026-09-01'),
        endsOn: null,
        autoRenew: true,
      }).isLeft(),
    ).toBe(true)
    expect(
      ServiceContract.draft({
        ...base,
        startsOn: day('2026-09-01'),
        endsOn: day('2027-08-31'),
      }).isRight(),
    ).toBe(true)
  })
})

describe('amendments', () => {
  it('leaves every earlier period with the revision and amount it had', () => {
    const subject = contract()
    const before = subject.schedule(whole)
    const revision = unwrap(
      subject.amend(
        {
          today,
          actor: 'ana',
          effectiveFrom: day('2026-11-01'),
          lines: [line(120_000n), line(30_000n, '2', 'Horas extras')],
          recurrence: 'monthly',
          reason,
        },
        now,
      ),
    )
    expect(revision.number).toBe(2)
    const after = subject.schedule(whole)
    const earlier = (periods: typeof before) =>
      periods
        .filter((period) => period.startsOn.isBefore(day('2026-11-01')))
        .map((period) => [period.competence, period.revision, period.amount.amount])
    expect(earlier(after)).toEqual(earlier(before))
    expect(after[2]).toMatchObject({ competence: '2026-11', revision: 2 })
    expect(after[2]?.amount.amount).toBe(180_000n)
    expect(subject.pullDomainEvents()[0]?.payloadOf()).toMatchObject({
      revision: 2,
      kind: 'amendment',
      effectiveFrom: '2026-11-01',
    })
  })

  it('refuses a period that has begun, a date inside a period, and a revision behind another', () => {
    const subject = contract()
    const change = {
      today,
      actor: 'ana',
      lines: [line(1n)],
      recurrence: 'monthly' as const,
      reason,
    }
    expect(subject.amend({ ...change, effectiveFrom: day('2026-09-01') }, now).isLeft()).toBe(true)
    expect(subject.amend({ ...change, effectiveFrom: day('2026-10-15') }, now).isLeft()).toBe(true)
    unwrap(subject.amend({ ...change, effectiveFrom: day('2027-01-01') }, now))
    expect(subject.amend({ ...change, effectiveFrom: day('2026-12-01') }, now).isLeft()).toBe(true)
    expect(subject.amend({ ...change, effectiveFrom: day('2027-09-01') }, now).isLeft()).toBe(true)
  })

  it('re-anchors the grid on a change of recurrence, and keeps the end on a period end', () => {
    const subject = contract()
    const change = { today, actor: 'ana', lines: [line(300_000n)], reason }
    // From March 2027, six months remain: two quarters fit.
    unwrap(
      subject.amend({ ...change, recurrence: 'quarterly', effectiveFrom: day('2027-03-01') }, now),
    )
    const periods = subject.schedule(whole)
    expect(periods.map((period) => period.competence).slice(-3)).toEqual([
      '2027-02',
      '2027-03',
      '2027-06',
    ])
    expect(periods.at(-1)?.endsOn.value).toBe('2027-08-31')
    // A yearly recurrence from October would not end on 2027-08-31.
    const other = contract()
    expect(
      other
        .amend({ ...change, recurrence: 'yearly', effectiveFrom: day('2026-10-01') }, now)
        .isLeft(),
    ).toBe(true)
  })
})

describe('suspension and cancellation', () => {
  it('removes exactly the periods a suspension covers', () => {
    const subject = contract()
    unwrap(
      subject.suspend(
        {
          today,
          actor: 'ana',
          suspensionId: randomUUID(),
          from: day('2026-12-01'),
          until: null,
          reason,
        },
        now,
      ),
    )
    unwrap(subject.resume({ today, actor: 'ana', at: day('2027-02-01') }, now))
    const excluded = subject
      .schedule(whole)
      .filter((period) => !period.billable)
      .map((period) => [period.competence, period.excluded])
    expect(excluded).toEqual([
      ['2026-12', 'suspended'],
      ['2027-01', 'suspended'],
    ])
    expect(subject.statusOn(day('2027-01-10'))).toBe('suspended')
    expect(subject.statusOn(day('2027-02-10'))).toBe('active')
    const events = subject.pullDomainEvents().map((event) => event.payloadOf())
    expect(events.map((payload) => payload.until)).toEqual([null, '2027-02-01'])
    expect(
      subject
        .suspend(
          {
            today,
            actor: 'ana',
            suspensionId: randomUUID(),
            from: day('2027-01-01'),
            until: null,
            reason,
          },
          now,
        )
        .isLeft(),
    ).toBe(true)
  })

  it('stops billing from the cancellation and never touches earlier periods', () => {
    const subject = contract()
    unwrap(subject.cancel({ today, actor: 'ana', from: day('2027-03-01'), reason }, now))
    const periods = subject.schedule(whole)
    expect(periods.filter((period) => period.billable)).toHaveLength(6)
    expect(periods.filter((period) => period.excluded === 'cancelled')).toHaveLength(6)
    expect(subject.statusOn(day('2027-03-01'))).toBe('cancelled')
    expect(
      subject.cancel({ today, actor: 'ana', from: day('2027-04-01'), reason }, now).isLeft(),
    ).toBe(true)
    expect(
      subject
        .renew(
          { today, actor: 'ana', readjustmentBasisPoints: null, reason, automatic: false },
          now,
        )
        .isLeft(),
    ).toBe(true)
  })
})

describe('renewal', () => {
  it('continues the schedule with no gap and no overlap, readjusted by a reviewer', () => {
    const subject = contract({ lines: [line(100_000n), line(33_333n, '1', 'Backup')] })
    const revision = unwrap(
      subject.renew(
        { today, actor: 'ana', readjustmentBasisPoints: 450, reason, automatic: false },
        now,
      ),
    )
    expect(revision).toMatchObject({ kind: 'renewal', readjustmentBasisPoints: 450 })
    expect(revision.effectiveFrom.value).toBe('2027-09-01')
    expect(subject.endsOn?.value).toBe('2028-08-31')
    const periods = subject.schedule(whole)
    expect(periods).toHaveLength(24)
    for (const [index, period] of periods.entries()) {
      const next = periods[index + 1]
      if (next) expect(period.endsOn.plusDays(1).value).toBe(next.startsOn.value)
    }
    expect(periods[12]).toMatchObject({ competence: '2027-09', revision: 2 })
    // 104500.00 + 34833.00 (33333 * 1.045 = 34832.985, half-up)
    expect(periods[12]?.amount.amount).toBe(139_333n)
    expect(periods[11]?.amount.amount).toBe(133_333n)
  })

  it('renews by itself only once its last period has begun, without readjustment', () => {
    const subject = contract({ autoRenew: true })
    const automatic = {
      actor: 'system:renewal',
      readjustmentBasisPoints: null,
      reason: null,
      automatic: true,
    }
    expect(subject.renew({ ...automatic, today }, now).isLeft()).toBe(true)
    unwrap(subject.renew({ ...automatic, today: day('2027-08-01') }, now))
    expect(subject.endsOn?.value).toBe('2028-08-31')
    expect(
      subject
        .renew({ ...automatic, today: day('2027-08-01'), readjustmentBasisPoints: 100 }, now)
        .isLeft(),
    ).toBe(true)
    expect(snapshotOf(subject).revisions.map((revision) => revision.kind)).toEqual([
      'initial',
      'renewal',
    ])
  })

  it('rounds a readjusted price half-up', () => {
    expect(readjusted(Money.fromAmount(33_333n, brl), 450).amount).toBe(34_833n)
    expect(readjusted(Money.fromAmount(1_000n, brl), -1_000).amount).toBe(900n)
  })
})
