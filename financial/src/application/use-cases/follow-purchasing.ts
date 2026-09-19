import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { Title, type TitleOrigin, type TitleTerms } from '@/domain/entities/title'
import { BusinessDate, Currency, Money } from '@/domain/value-objects/financial-values'
import { DocumentNumber, Reason } from '@/domain/value-objects/title-values'
import type { Clock } from '../ports/clock'
import type { FinancialScope } from '../ports/unit-of-work'

const PROCUREMENT_ACTOR = 'system:procurement'

export interface WireMoney {
  readonly amount: string
  readonly currency: string
}

export interface WireInstallment {
  readonly number: number
  readonly dueOn: string
  readonly amount: WireMoney
}

export interface ApprovedPurchaseOrder {
  readonly orderId: string
  readonly supplierId: string
  readonly issuedOn: string
  readonly total: WireMoney
  readonly installments: readonly WireInstallment[]
}

/**
 * An approved purchase order becomes a **forecast** payable.
 *
 * The company has committed to the money but owes nothing yet: nothing has arrived, and a
 * forecast never posts and never reaches the ledger. What it is for is being visible in
 * what is coming, which is the whole reason a cash flow outlook is worth reading.
 */
export class RaisePayableForecastUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: FinancialScope,
    order: ApprovedPurchaseOrder,
  ): Promise<Either<InvalidInputError, 'raised' | 'ignored'>> {
    if (await scope.titles.findByOriginForUpdate('payable', order.orderId)) return right('ignored')
    return raise(scope, {
      origin: { type: 'purchase-order', documentId: order.orderId },
      reference: `PO-${order.orderId.slice(-8).toUpperCase()}`,
      partyId: order.supplierId,
      issuedOn: order.issuedOn,
      currency: order.total.currency,
      installments: order.installments,
      stage: 'forecast',
      action: 'payable.forecast-raised',
      details: { orderId: order.orderId },
      now: this.clock.now(),
    })
  }
}

export interface RecordedReceipt {
  readonly orderId: string
  readonly receiptId: string
  readonly supplierId: string
  readonly receivedOn: string
  readonly value: WireMoney
  readonly installments: readonly WireInstallment[]
  readonly remaining: WireMoney
  readonly remainingInstallments: readonly WireInstallment[]
}

/**
 * Goods arrived, so part of what was committed is now owed.
 *
 * Two things happen together and have to happen together: the delivery raises an effective
 * payable for what it carries, and the order's forecast drops to what is still committed
 * and has not arrived. Doing one without the other would count the same money twice — as
 * expected and as owed at the same time — which is exactly what the forecast stage exists
 * to prevent.
 */
export class RecordPayableFromReceiptUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: FinancialScope,
    receipt: RecordedReceipt,
  ): Promise<Either<InvalidInputError, 'raised' | 'ignored'>> {
    const now = this.clock.now()
    const reduced = await reduceForecast(
      scope,
      receipt.orderId,
      receipt.remaining,
      receipt.remainingInstallments,
      now,
    )
    if (reduced.isLeft()) return left(reduced.value)
    if (await scope.titles.findByOriginForUpdate('payable', receipt.receiptId))
      return right('ignored')
    if (receipt.installments.length === 0) return right('ignored')
    return raise(scope, {
      origin: { type: 'purchase-receipt', documentId: receipt.receiptId },
      reference: `GR-${receipt.receiptId.slice(-8).toUpperCase()}`,
      partyId: receipt.supplierId,
      issuedOn: receipt.receivedOn,
      currency: receipt.value.currency,
      installments: receipt.installments,
      stage: 'effective',
      action: 'payable.raised-from-receipt',
      details: { orderId: receipt.orderId, receiptId: receipt.receiptId },
      now,
    })
  }
}

export interface ReturnedReceipt {
  readonly orderId: string
  readonly receiptId: string
  readonly remaining: WireMoney
  readonly remainingInstallments: readonly WireInstallment[]
}

/**
 * The delivery went back, so what it made owed goes with it and what the order still
 * expects goes back up.
 *
 * A payable already posted is a debt somebody accepted; only a person may reverse one, so
 * it is left alone and the return is theirs to settle.
 */
export class WithdrawPayableOfReceiptUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: FinancialScope,
    returned: ReturnedReceipt,
  ): Promise<Either<InvalidInputError, 'withdrawn' | 'ignored'>> {
    const now = this.clock.now()
    const restored = await reduceForecast(
      scope,
      returned.orderId,
      returned.remaining,
      returned.remainingInstallments,
      now,
    )
    if (restored.isLeft()) return left(restored.value)
    const title = await scope.titles.findByOriginForUpdate('payable', returned.receiptId)
    if (title?.status !== 'draft') return right('ignored')
    const reason = Reason.create('The delivery was returned to the supplier')
    if (reason.isLeft()) return left(reason.value)
    const cancelled = title.cancel(reason.value, now)
    if (cancelled.isLeft()) return right('ignored')
    await scope.titles.save(title)
    await append(scope, 'payable.withdrawn-with-return', title.id.toString(), now, {
      orderId: returned.orderId,
      receiptId: returned.receiptId,
    })
    return right('withdrawn')
  }
}

/** Nothing more will arrive against the order, so nothing more is expected from it. */
export class WithdrawPayableForecastUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: FinancialScope,
    orderId: string,
    why: string,
  ): Promise<'withdrawn' | 'ignored'> {
    const title = await scope.titles.findByOriginForUpdate('payable', orderId)
    if (title?.status !== 'draft' || title.stage !== 'forecast') return 'ignored'
    const reason = Reason.create(why)
    if (reason.isLeft()) throw reason.value
    const now = this.clock.now()
    const cancelled = title.cancel(reason.value, now)
    if (cancelled.isLeft()) return 'ignored'
    await scope.titles.save(title)
    await append(scope, 'payable.forecast-withdrawn', title.id.toString(), now, { orderId })
    return 'withdrawn'
  }
}

/**
 * Leave the order's forecast showing exactly what is still committed and has not arrived.
 *
 * When nothing is left it is cancelled rather than kept at zero, because a forecast of
 * nothing is not something anybody needs to read.
 */
async function reduceForecast(
  scope: FinancialScope,
  orderId: string,
  remaining: WireMoney,
  installments: readonly WireInstallment[],
  now: Date,
): Promise<Either<InvalidInputError, 'reduced' | 'withdrawn' | 'ignored'>> {
  const forecast = await scope.titles.findByOriginForUpdate('payable', orderId)
  if (!forecast || forecast.stage !== 'forecast') return right('ignored')
  const wanted = remaining.amount !== '0' && installments.length > 0
  // A commitment can come back: goods returned to a supplier are goods it still owes.
  if (wanted && forecast.status === 'cancelled' && forecast.reinstate(now).isLeft())
    return right('ignored')
  if (forecast.status !== 'draft') return right('ignored')
  if (!wanted) {
    const reason = Reason.create('Everything this order committed to has arrived')
    if (reason.isLeft()) return left(reason.value)
    const cancelled = forecast.cancel(reason.value, now)
    if (cancelled.isLeft()) return right('ignored')
    await scope.titles.save(forecast)
    await append(scope, 'payable.forecast-withdrawn', forecast.id.toString(), now, { orderId })
    return right('withdrawn')
  }
  const schedule = scheduleOf(installments, forecast.currency)
  if (schedule.isLeft()) return left(schedule.value)
  const revised = forecast.revise({ ...forecast.termsOf(), installments: schedule.value }, now)
  if (revised.isLeft()) return right('ignored')
  await scope.titles.save(forecast)
  await append(scope, 'payable.forecast-reduced', forecast.id.toString(), now, {
    orderId,
    remaining: remaining.amount,
  })
  return right('reduced')
}

interface RaiseInput {
  readonly origin: TitleOrigin
  readonly reference: string
  readonly partyId: string
  readonly issuedOn: string
  readonly currency: string
  readonly installments: readonly WireInstallment[]
  readonly stage: 'forecast' | 'effective'
  readonly action: string
  readonly details: Readonly<Record<string, unknown>>
  readonly now: Date
}

async function raise(
  scope: FinancialScope,
  input: RaiseInput,
): Promise<Either<InvalidInputError, 'raised'>> {
  const currency = Currency.create(input.currency)
  if (currency.isLeft()) return left(currency.value)
  const issuedOn = BusinessDate.create(input.issuedOn, '/issuedOn')
  if (issuedOn.isLeft()) return left(issuedOn.value)
  const documentNumber = DocumentNumber.create(input.reference)
  if (documentNumber.isLeft()) return left(documentNumber.value)
  const installments = scheduleOf(input.installments, currency.value)
  if (installments.isLeft()) return left(installments.value)
  const terms: TitleTerms = {
    partyId: input.partyId,
    documentNumber: documentNumber.value,
    description: null,
    currency: currency.value,
    categoryId: null,
    issuedOn: issuedOn.value,
    competenceOn: issuedOn.value,
    installments: installments.value,
    allocations: [],
  }
  const title = Title.draft({
    tenantId: scope.tenantId,
    direction: 'payable',
    origin: input.origin,
    terms,
    stage: input.stage,
    now: input.now,
  })
  if (title.isLeft()) return left(title.value)
  await scope.titles.create(title.value)
  await append(scope, input.action, title.value.id.toString(), input.now, {
    ...input.details,
    total: title.value.total().amount.toString(),
    currency: currency.value.value,
    stage: input.stage,
  })
  return right('raised')
}

function scheduleOf(
  installments: readonly WireInstallment[],
  currency: Currency,
): Either<InvalidInputError, TitleTerms['installments']> {
  const parsed: { dueOn: BusinessDate; amount: Money }[] = []
  for (const installment of installments) {
    const dueOn = BusinessDate.create(installment.dueOn, '/dueOn')
    if (dueOn.isLeft()) return left(dueOn.value)
    const amount = Money.create(installment.amount.amount, currency)
    if (amount.isLeft()) return left(amount.value)
    parsed.push({ dueOn: dueOn.value, amount: amount.value })
  }
  return right(parsed)
}

function append(
  scope: FinancialScope,
  action: string,
  subjectId: string,
  occurredAt: Date,
  details: Readonly<Record<string, unknown>>,
) {
  return scope.audit.append({
    actor: PROCUREMENT_ACTOR,
    action,
    subjectType: 'title',
    subjectId,
    occurredAt,
    requestId: null,
    details,
  })
}
