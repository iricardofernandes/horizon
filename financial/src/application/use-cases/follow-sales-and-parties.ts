import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { Title, type TitleTerms } from '@/domain/entities/title'
import { BusinessDate, Currency, Money } from '@/domain/value-objects/financial-values'
import { DocumentNumber, Reason } from '@/domain/value-objects/title-values'
import type { Clock } from '../ports/clock'
import type { FinancialScope } from '../ports/unit-of-work'

const SALES_ACTOR = 'system:sales'

/** One payment the customer agreed to, as Sales published the order's terms. */
export interface AgreedInstallment {
  readonly number: number
  readonly dueOn: string
  readonly amount: { readonly amount: string; readonly currency: string }
}

export interface ConfirmedOrder {
  readonly orderId: string
  readonly customerId: string
  readonly confirmedAt: string
  readonly total: { readonly amount: string; readonly currency: string }
  /** Absent from an order placed before payment terms existed, or by a consumer that omits them. */
  readonly installments?: readonly AgreedInstallment[] | undefined
}

/**
 * A confirmed sales order becomes a **forecast** receivable: Sales knows what was sold,
 * Financial decides how and when it is collected, and until the order is invoiced the money
 * is expected rather than owed. A forecast never posts and never reaches the ledger, so a
 * confirmed order cannot show up as a claim on a customer who has not been billed.
 *
 * Redelivery of the same confirmation never raises a second title.
 */
export class RaiseReceivableFromOrderUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: FinancialScope,
    order: ConfirmedOrder,
  ): Promise<Either<InvalidInputError, 'raised' | 'ignored'>> {
    if (await scope.titles.findByOriginForUpdate('receivable', order.orderId))
      return right('ignored')
    return raise(scope, order, 'forecast', this.clock.now())
  }
}

/**
 * Raise the order's receivable, at the stage the caller is entitled to claim.
 *
 * Both handlers can be the first to arrive — Sales emits the confirmation and the invoicing
 * request from the same operation, and they race through the queue — so both can create the
 * title. Whichever loses finds it already there and does nothing, which is what makes the
 * outcome the same either way round.
 */
async function raise(
  scope: FinancialScope,
  order: ConfirmedOrder,
  stage: 'forecast' | 'effective',
  now: Date,
): Promise<Either<InvalidInputError, 'raised'>> {
  const currency = Currency.create(order.total.currency)
  if (currency.isLeft()) return left(currency.value)
  const total = Money.create(order.total.amount, currency.value)
  if (total.isLeft()) return left(total.value)
  const confirmed = BusinessDate.create(order.confirmedAt.slice(0, 10), '/confirmedAt')
  if (confirmed.isLeft()) return left(confirmed.value)
  const confirmedOn = confirmed.value
  const schedule = scheduleOf(order, total.value)
  if (schedule.isLeft()) return left(schedule.value)
  // A schedule is agreed from the day the order was issued, which can be the day before it
  // was confirmed. The claim is not allowed to fall due before it exists, so the earlier
  // of the two dates is the one the title is issued on.
  const [first] = schedule.value
  const issuedOn = first && first.dueOn.value < confirmedOn.value ? first.dueOn : confirmedOn
  const documentNumber = DocumentNumber.create(`SO-${order.orderId.slice(-8).toUpperCase()}`)
  if (documentNumber.isLeft()) return left(documentNumber.value)
  const title = Title.draft({
    tenantId: scope.tenantId,
    direction: 'receivable',
    origin: { type: 'sales-order', documentId: order.orderId },
    terms: {
      partyId: order.customerId,
      documentNumber: documentNumber.value,
      description: null,
      currency: currency.value,
      categoryId: null,
      issuedOn,
      competenceOn: confirmedOn,
      installments: schedule.value,
      allocations: [],
    },
    stage,
    now,
  })
  if (title.isLeft()) return left(title.value)
  await scope.titles.create(title.value)
  await scope.audit.append({
    actor: SALES_ACTOR,
    action: 'receivable.drafted',
    subjectType: 'title',
    subjectId: title.value.id.toString(),
    occurredAt: now,
    requestId: null,
    details: {
      orderId: order.orderId,
      total: total.value.amount,
      currency: currency.value.value,
      installments: schedule.value.length,
      stage,
    },
  })
  return right('raised')
}

/**
 * The schedule the order was confirmed under.
 *
 * Sales publishes what the customer actually agreed to — on delivery, thirty days, or three
 * payments — and Financial raises the receivable on that. An order that carries no terms,
 * because it predates them or came from a consumer that omits them, still expects its money
 * once, on the day it was confirmed.
 */
function scheduleOf(
  order: ConfirmedOrder,
  total: Money,
): Either<InvalidInputError, readonly { dueOn: BusinessDate; amount: Money }[]> {
  const agreed = order.installments ?? []
  const schedule: { dueOn: BusinessDate; amount: Money }[] = []
  for (const [index, installment] of agreed.entries()) {
    const dueOn = BusinessDate.create(installment.dueOn, `/installments/${index}/dueOn`)
    if (dueOn.isLeft()) return left(dueOn.value)
    const amountCurrency = Currency.create(installment.amount.currency)
    if (amountCurrency.isLeft()) return left(amountCurrency.value)
    const amount = Money.create(installment.amount.amount, amountCurrency.value)
    if (amount.isLeft()) return left(amount.value)
    // An instalment for nothing is not an instalment: an even split of a total smaller
    // than the number of parts leaves the last ones empty, and they are simply not raised.
    if (amount.value.amount === 0n) continue
    schedule.push({ dueOn: dueOn.value, amount: amount.value })
  }
  if (schedule.length === 0) {
    const dueOn = BusinessDate.create(order.confirmedAt.slice(0, 10), '/confirmedAt')
    if (dueOn.isLeft()) return left(dueOn.value)
    return right([{ dueOn: dueOn.value, amount: total }])
  }
  return right(schedule)
}

/** Invoicing describes the same order as its confirmation, and says the same things about it. */
export type RequestedInvoicing = ConfirmedOrder

/**
 * Invoicing turns the order's forecast into an effective receivable.
 *
 * The same title changes stage, so the expected money and the claim on the customer are
 * never both counted at once — which is what makes duplication impossible rather than
 * merely unlikely. When the invoice differs from the order, its total replaces the
 * forecast's on the single installment Sales knows about; a person reschedules from there.
 */
export class RealiseForecastFromInvoicingUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: FinancialScope,
    invoicing: RequestedInvoicing,
  ): Promise<Either<InvalidInputError, 'realised' | 'raised' | 'ignored'>> {
    const title = await scope.titles.findByOriginForUpdate('receivable', invoicing.orderId)
    // Invoicing is what makes a receivable real, so when it wins the race with the
    // confirmation it raises the title effective and the confirmation then finds it.
    if (!title) return raise(scope, invoicing, 'effective', this.clock.now())
    if (title.stage !== 'forecast' || title.status !== 'draft') return right('ignored')
    const now = this.clock.now()
    const revised = revisedTerms(title, invoicing)
    if (revised.isLeft()) return left(revised.value)
    const realised = title.realise(revised.value, now)
    if (realised.isLeft()) return right('ignored')
    await scope.titles.save(title)
    await scope.audit.append({
      actor: SALES_ACTOR,
      action: 'receivable.realised',
      subjectType: 'title',
      subjectId: title.id.toString(),
      occurredAt: now,
      requestId: null,
      details: { orderId: invoicing.orderId, total: title.total().amount },
    })
    return right('realised')
  }
}

/** The forecast's own terms, with the invoiced total when it differs from the ordered one. */
function revisedTerms(
  title: Title,
  invoicing: RequestedInvoicing,
): Either<InvalidInputError, TitleTerms | null> {
  const terms = title.termsOf()
  if (invoicing.total.amount === title.total().amount.toString()) return right(null)
  const total = Money.create(invoicing.total.amount, terms.currency)
  if (total.isLeft()) return left(total.value)
  // An invoice worth something other than the order is a change nobody agreed a schedule
  // for, so it only replaces a forecast that expects one payment. A schedule — whether a
  // person built it or the quote's terms did — is not redistributed behind their back.
  const [first, ...rest] = terms.installments
  if (!first || rest.length > 0) return right(null)
  return right({ ...terms, installments: [{ dueOn: first.dueOn, amount: total.value }] })
}

/**
 * A cancelled order withdraws its draft receivable. A receivable already posted is a claim
 * someone accepted; only a person may reverse it, so it is left alone.
 */
export class WithdrawReceivableOfOrderUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(scope: FinancialScope, orderId: string): Promise<'withdrawn' | 'ignored'> {
    const title = await scope.titles.findByOriginForUpdate('receivable', orderId)
    if (title?.status !== 'draft') return 'ignored'
    const reason = Reason.create('Sales order cancelled')
    if (reason.isLeft()) throw reason.value
    const now = this.clock.now()
    const cancelled = title.cancel(reason.value, now)
    if (cancelled.isLeft()) return 'ignored'
    await scope.titles.save(title)
    await scope.audit.append({
      actor: SALES_ACTOR,
      action: 'receivable.cancelled',
      subjectType: 'title',
      subjectId: title.id.toString(),
      occurredAt: now,
      requestId: null,
      details: { orderId, reason: reason.value.value },
    })
    return 'withdrawn'
  }
}
