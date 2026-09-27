import { randomUUID } from 'node:crypto'
import { snapshotOf } from 'test/support/snapshot-of'
import { ServiceContract } from './entities/service-contract'
import type { ContractLine, Recurrence } from './services/contract-schedule'
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
    billingDay?: number
    lines?: ContractLine[]
    paymentTermDays?: number[]
  } = {},
) {
  const created = unwrap(
    ServiceContract.draft({
      tenantId: randomUUID(),
      customerId: randomUUID(),
      currency: brl,
      lines: options.lines ?? [line(100_000n), line(25_000n, '2', 'Horas extras')],
      recurrence: options.recurrence ?? 'monthly',
      startsOn: day(options.startsOn ?? '2026-08-01'),
      endsOn: null,
      billingDay: options.billingDay ?? 5,
      autoRenew: false,
      paymentTerms: unwrap(PaymentTerms.create(options.paymentTermDays ?? [10, 40])),
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

const ids = () => ({ billedPeriodId: randomUUID(), entryId: () => randomUUID() })

describe('billing a contract period', () => {
  it('freezes the revision, lines, amount and installments, and bills a month once', () => {
    const subject = contract()
    const billed = unwrap(
      subject.bill({ competence: '2026-09', today, actor: 'ana', runId: null, ...ids() }, now),
    )
    expect(billed).toMatchObject({ competence: '2026-09', revision: 1 })
    expect(billed.value.amount).toBe(150_000n)
    expect(billed.issuedOn.value).toBe('2026-09-05')
    expect(
      billed.installments.map((installment) => [
        installment.dueOn.value,
        installment.amount.amount,
      ]),
    ).toEqual([
      ['2026-09-15', 75_000n],
      ['2026-10-15', 75_000n],
    ])
    const [event] = subject.pullDomainEvents()
    expect(event?.eventType).toBe('sales.contract-period.billed')
    expect(event?.payloadOf()).toMatchObject({
      billedPeriodId: billed.id,
      competence: '2026-09',
      startsOn: '2026-09-01',
      endsOn: '2026-09-30',
      issuedOn: '2026-09-05',
      value: { amount: '150000', currency: 'BRL' },
      runId: null,
    })
    expect(
      subject.bill({ competence: '2026-09', today, actor: 'ana', runId: null, ...ids() }, now),
    ).toMatchObject({ value: { message: 'this period was already billed' } })
    expect(subject.billingFor('2026-09', today)).toMatchObject({
      kind: 'skip',
      reason: 'already-billed',
    })
  })

  it('says why a period is not billed: not due, suspended, cancelled, or nothing to bill', () => {
    const early = contract({ billingDay: 25 })
    expect(early.billingFor('2026-09', today)).toMatchObject({ reason: 'not-due-yet' })
    expect(early.billingFor('2026-09', day('2026-09-25'))).toMatchObject({ kind: 'bill' })

    const paused = contract({ startsOn: '2026-09-01' })
    unwrap(
      paused.suspend(
        {
          today,
          actor: 'ana',
          suspensionId: randomUUID(),
          from: day('2026-10-01'),
          until: day('2026-11-01'),
          reason,
        },
        now,
      ),
    )
    unwrap(paused.cancel({ today, actor: 'ana', from: day('2026-12-01'), reason }, now))
    const later = day('2026-12-20')
    expect(paused.billingFor('2026-10', later)).toMatchObject({ reason: 'suspended' })
    expect(paused.billingFor('2026-11', later)).toMatchObject({ kind: 'bill' })
    expect(paused.billingFor('2026-12', later)).toMatchObject({ reason: 'cancelled' })

    const free = contract({ lines: [line(0n)] })
    expect(free.billingFor('2026-09', today)).toMatchObject({ reason: 'nothing-to-bill' })
  })

  it('has no period in a month where none starts, nor before the start', () => {
    const quarterly = contract({ recurrence: 'quarterly', startsOn: '2026-07-01', billingDay: 1 })
    expect(quarterly.billingFor('2026-08', today)).toBeNull()
    expect(quarterly.billingFor('2026-07', today)).toMatchObject({ kind: 'bill' })
    expect(quarterly.billingFor('2026-06', today)).toBeNull()
    expect(
      quarterly.bill({ competence: '2026-08', today, actor: 'ana', runId: null, ...ids() }, now),
    ).toMatchObject({ value: { message: 'the contract has no period to bill in 2026-08' } })
  })
})

describe('billed periods and later changes', () => {
  it('keeps a billed period as it was billed when the contract is amended afterwards', () => {
    const subject = contract()
    const billed = unwrap(
      subject.bill({ competence: '2026-09', today, actor: 'ana', runId: null, ...ids() }, now),
    )
    unwrap(
      subject.amend(
        {
          today,
          actor: 'ana',
          effectiveFrom: day('2026-10-01'),
          lines: [line(300_000n)],
          recurrence: 'monthly',
          reason,
        },
        now,
      ),
    )
    const [after] = subject.billedPeriods()
    expect(after).toEqual(billed)
    expect(snapshotOf(subject).billedPeriods[0]).toMatchObject({ revision: 1, value: '150000' })
    const october = subject.billingFor('2026-10', day('2026-10-05'))
    expect(october).toMatchObject({ kind: 'bill', period: { revision: 2 } })
  })

  it('refuses a change from a period that was already billed', () => {
    const subject = contract({ startsOn: '2026-10-01', billingDay: 1 })
    const first = day('2026-10-01')
    unwrap(
      subject.bill(
        { competence: '2026-10', today: first, actor: 'ana', runId: null, ...ids() },
        now,
      ),
    )
    const change = { today: first, actor: 'ana', reason }
    expect(
      subject.amend(
        { ...change, effectiveFrom: first, lines: [line(1n)], recurrence: 'monthly' },
        now,
      ),
    ).toMatchObject({
      value: { message: 'a period from then on is already billed; choose a later period' },
    })
    expect(
      subject
        .suspend({ ...change, suspensionId: randomUUID(), from: first, until: null }, now)
        .isLeft(),
    ).toBe(true)
    expect(subject.cancel({ ...change, from: first }, now).isLeft()).toBe(true)
    expect(subject.cancel({ ...change, from: day('2026-11-01') }, now).isRight()).toBe(true)
  })
})

describe('crediting a billed period', () => {
  it('keeps the period, marks it credited once, and never bills it again', () => {
    const subject = contract()
    const billed = unwrap(
      subject.bill({ competence: '2026-09', today, actor: 'ana', runId: null, ...ids() }, now),
    )
    subject.pullDomainEvents()
    const credited = unwrap(
      subject.credit(
        { today, actor: 'bia', competence: '2026-09', reasonCode: 'not-provided', reason },
        now,
      ),
    )
    expect(credited).toMatchObject({ id: billed.id, value: billed.value, lines: billed.lines })
    expect(credited.credit).toMatchObject({ reasonCode: 'not-provided', by: 'bia' })
    const [event] = subject.pullDomainEvents()
    expect(event?.payloadOf()).toMatchObject({
      billedPeriodId: billed.id,
      competence: '2026-09',
      entryIds: billed.lines.map((each) => each.entryId),
      reasonCode: 'not-provided',
      creditedOn: '2026-09-20',
    })
    expect(
      subject
        .credit(
          { today, actor: 'bia', competence: '2026-09', reasonCode: 'billing-error', reason },
          now,
        )
        .isLeft(),
    ).toBe(true)
    expect(
      subject
        .credit(
          { today, actor: 'bia', competence: '2026-08', reasonCode: 'billing-error', reason },
          now,
        )
        .isLeft(),
    ).toBe(true)
    expect(subject.billingFor('2026-09', today)).toMatchObject({ reason: 'already-billed' })
  })
})
