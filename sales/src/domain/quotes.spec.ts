import { randomUUID } from 'node:crypto'
import { snapshotOf } from 'test/support/snapshot-of'
import { Quote, type QuoteLine, type QuoteTerms } from './entities/quote'
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
const money = (value: string) => unwrap(Money.create(value, brl))
const reason = (value: string) => unwrap(Reason.create(value))
const written = new Date('2026-09-14T20:00:00.000Z')
const later = (minutes: number) => new Date(written.getTime() + minutes * 60_000)
const validUntil = new Date('2026-09-29T20:00:00.000Z')

function line(unitPrice: string, quantity = '2'): QuoteLine {
  const amount = unwrap(Quantity.create(quantity))
  return {
    lineId: randomUUID(),
    itemId: randomUUID(),
    quantity: amount,
    description: unwrap(LineDescription.create('Coffee')),
    unitPrice: money(unitPrice),
    lineTotal: money(unitPrice).multiply(amount),
  }
}

function terms(overrides: Partial<QuoteTerms> = {}): QuoteTerms {
  return {
    sellerId: null,
    discount: Money.fromAmount(0n, brl),
    freight: Money.fromAmount(0n, brl),
    carrier: null,
    paymentTerms: PaymentTerms.immediate(),
    notes: null,
    ...overrides,
  }
}

function offer(overrides: { lines?: readonly QuoteLine[]; terms?: QuoteTerms } = {}) {
  const lines = overrides.lines ?? [line('1000')]
  return unwrap(
    Quote.draft({
      tenantId: randomUUID(),
      customerId: randomUUID(),
      currency: brl,
      lines,
      terms: overrides.terms ?? terms(),
      expiresAt: validUntil,
      now: written,
    }),
  )
}

describe('the offer to a customer', () => {
  it('totals the goods, the freight and the discount, and says how deep the discount is', () => {
    const quote = offer({
      lines: [line('1000')],
      terms: terms({ freight: money('500'), discount: money('200') }),
    })
    expect(quote.net().amount).toBe(2000n)
    expect(quote.total().amount).toBe(2300n)
    // Two hundred off two thousand of goods: one thousand basis points, ten percent.
    expect(quote.discountBasisPoints()).toBe(1000)
    expect(snapshotOf(quote)).toMatchObject({ version: 1, status: 'draft', approvalState: 'none' })
  })

  it('refuses an offer worth nothing and a discount deeper than what is charged', () => {
    expect(
      Quote.draft({
        tenantId: randomUUID(),
        customerId: randomUUID(),
        currency: brl,
        lines: [line('1000')],
        terms: terms({ discount: money('3000') }),
        expiresAt: validUntil,
        now: written,
      }).isLeft(),
    ).toBe(true)
    expect(
      Quote.draft({
        tenantId: randomUUID(),
        customerId: randomUUID(),
        currency: brl,
        lines: [line('0')],
        terms: terms(),
        expiresAt: validUntil,
        now: written,
      }).isLeft(),
    ).toBe(true)
  })

  it('publishes what the customer was shown when the offer goes out', () => {
    const quote = offer()
    expect(quote.send('ana', later(1), { approvalRequired: false }).isRight()).toBe(true)
    expect(snapshotOf(quote)).toMatchObject({ status: 'sent', approvalState: 'not-required' })
    const [sent] = quote.pullDomainEvents()
    expect(sent?.eventType).toBe('sales.quote.sent')
    expect(sent?.payloadOf()).toMatchObject({
      quoteId: quote.id.toString(),
      quoteRoot: quote.id.toString(),
      version: 1,
      total: { amount: '2000', currency: 'BRL' },
      expiresAt: validUntil.toISOString(),
    })
    // A quote that has left is never sent twice, and never rewritten in place.
    expect(quote.send('ana', later(2), { approvalRequired: false }).isLeft()).toBe(true)
    expect(
      quote
        .revise({ lines: [line('900')], terms: terms(), expiresAt: validUntil }, later(2))
        .isLeft(),
    ).toBe(true)
  })

  it('holds a deep discount for somebody who did not ask for it', () => {
    const quote = offer({ terms: terms({ discount: money('400') }) })
    expect(quote.send('ana', later(1), { approvalRequired: true }).isRight()).toBe(true)
    expect(snapshotOf(quote)).toMatchObject({
      status: 'pending',
      approvalState: 'pending',
      approvalRequestedBy: 'ana',
    })
    expect(quote.pullDomainEvents()).toHaveLength(0)
    // Four eyes: whoever asked for the discount cannot be the one who grants it.
    expect(quote.approve('ana', later(2)).isLeft()).toBe(true)
    expect(quote.approve('bruno', later(3)).isRight()).toBe(true)
    expect(snapshotOf(quote)).toMatchObject({
      status: 'sent',
      approvalState: 'approved',
      approvalDecidedBy: 'bruno',
    })
    expect(quote.pullDomainEvents().map((event) => event.eventType)).toEqual(['sales.quote.sent'])
  })

  it('sends a refused discount back to the desk it came from, with the reason', () => {
    const quote = offer({ terms: terms({ discount: money('400') }) })
    unwrap(quote.send('ana', later(1), { approvalRequired: true }))
    expect(
      quote.refuseApproval('bruno', reason('Too deep for this account'), later(2)).isRight(),
    ).toBe(true)
    expect(snapshotOf(quote)).toMatchObject({
      status: 'draft',
      approvalState: 'rejected',
      approvalReason: 'Too deep for this account',
    })
    // Back to a draft, so it can be negotiated again and sent afresh.
    expect(
      quote
        .revise({ lines: [line('1000')], terms: terms(), expiresAt: validUntil }, later(3))
        .isRight(),
    ).toBe(true)
    expect(snapshotOf(quote)).toMatchObject({ approvalState: 'none' })
  })

  it('answers a sent offer with a new version that supersedes it', () => {
    const quote = offer()
    unwrap(quote.send('ana', later(1), { approvalRequired: false }))
    quote.pullDomainEvents()
    const next = unwrap(
      quote.nextVersion({ lines: [line('900')], terms: terms(), expiresAt: validUntil }, later(2)),
    )
    expect(quote.supersede(next.id.toString(), later(2)).isRight()).toBe(true)
    expect(snapshotOf(quote)).toMatchObject({
      status: 'superseded',
      supersededBy: next.id.toString(),
      version: 1,
    })
    expect(snapshotOf(next)).toMatchObject({
      status: 'draft',
      version: 2,
      rootId: quote.rootId,
      supersedes: quote.id.toString(),
      total: '1800',
    })
    // Every version of one offer shares the first one's identifier.
    expect(next.rootId).toBe(quote.id.toString())
  })

  it('keeps the offer that was agreed: an accepted quote has no next version', () => {
    const quote = offer()
    unwrap(quote.send('ana', later(1), { approvalRequired: false }))
    unwrap(quote.accept(later(2)))
    quote.pullDomainEvents()
    expect(
      quote
        .nextVersion({ lines: [line('900')], terms: terms(), expiresAt: validUntil }, later(3))
        .isLeft(),
    ).toBe(true)
    expect(quote.supersede(randomUUID(), later(3)).isLeft()).toBe(true)
  })

  it('records the acceptance, and turns it into exactly one order', () => {
    const quote = offer()
    unwrap(quote.send('ana', later(1), { approvalRequired: false }))
    quote.pullDomainEvents()
    expect(quote.accept(later(2)).isRight()).toBe(true)
    const [accepted] = quote.pullDomainEvents()
    expect(accepted?.eventType).toBe('sales.quote.accepted')
    expect(accepted?.payloadOf()).toMatchObject({
      version: 1,
      customerId: quote.customerId,
      total: { amount: '2000', currency: 'BRL' },
    })
    const orderId = randomUUID()
    expect(quote.markOrdered(orderId, later(3)).isRight()).toBe(true)
    expect(quote.markOrdered(randomUUID(), later(4)).isLeft()).toBe(true)
    expect(snapshotOf(quote)).toMatchObject({ orderId })
  })

  it('records a refusal with the reason the customer gave', () => {
    const quote = offer()
    unwrap(quote.send('ana', later(1), { approvalRequired: false }))
    quote.pullDomainEvents()
    expect(quote.decline(reason('Bought elsewhere'), later(2)).isRight()).toBe(true)
    const [declined] = quote.pullDomainEvents()
    expect(declined?.eventType).toBe('sales.quote.rejected')
    expect(declined?.payloadOf()).toMatchObject({ reason: 'Bought elsewhere', version: 1 })
    expect(snapshotOf(quote)).toMatchObject({
      status: 'rejected',
      closureReason: 'Bought elsewhere',
    })
  })

  it('expires only once the date has passed, and refuses a late acceptance', () => {
    const quote = offer()
    unwrap(quote.send('ana', later(1), { approvalRequired: false }))
    quote.pullDomainEvents()
    expect(quote.expire(later(2)).isLeft()).toBe(true)
    const late = new Date(validUntil.getTime() + 60_000)
    expect(quote.accept(late).isLeft()).toBe(true)
    // Recorded as it was found, so a list reads as it is rather than as it was.
    expect(snapshotOf(quote)).toMatchObject({ status: 'expired' })
    expect(quote.pullDomainEvents()).toHaveLength(0)
  })

  it('never sends an offer that expired before it left', () => {
    const quote = offer()
    expect(
      quote.send('ana', new Date(validUntil.getTime() + 1), { approvalRequired: false }).isLeft(),
    ).toBe(true)
    expect(snapshotOf(quote)).toMatchObject({ status: 'draft' })
  })

  it('carries the agreed terms, including when each instalment falls due', () => {
    const issuedOn = unwrap(BusinessDate.create('2026-09-14'))
    const payment = unwrap(PaymentTerms.create([0, 30, 60]))
    const schedule = payment.scheduleOf(money('1000'), issuedOn)
    expect(schedule.map((installment) => installment.dueOn.value)).toEqual([
      '2026-09-14',
      '2026-10-14',
      '2026-11-13',
    ])
    // A split invents no minor unit and loses none: the parts add back up to the total.
    expect(schedule.reduce((sum, part) => sum + part.amount.amount, 0n)).toBe(1000n)
    expect(PaymentTerms.create([30, 30]).isLeft()).toBe(true)
    expect(PaymentTerms.create([]).isLeft()).toBe(true)
    expect(PaymentTerms.create([400]).isLeft()).toBe(true)
  })
})
