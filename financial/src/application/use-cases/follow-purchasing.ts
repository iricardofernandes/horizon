import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { Reason } from '@/domain/value-objects/title-values'
import type { Clock } from '../ports/clock'
import type { FinancialScope } from '../ports/unit-of-work'
import { append, raise, reduceForecast, type WireInstallment, type WireMoney } from './title-flows'

const PROCUREMENT_ACTOR = 'system:procurement'

export type { WireInstallment, WireMoney }

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
      direction: 'payable',
      actor: PROCUREMENT_ACTOR,
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
    const reduced = await reduceForecast(scope, forecastOf(receipt.orderId, receipt, now))
    if (reduced.isLeft()) return left(reduced.value)
    if (await scope.titles.findByOriginForUpdate('payable', receipt.receiptId))
      return right('ignored')
    if (receipt.installments.length === 0) return right('ignored')
    return raise(scope, {
      direction: 'payable',
      actor: PROCUREMENT_ACTOR,
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
    const restored = await reduceForecast(scope, forecastOf(returned.orderId, returned, now))
    if (restored.isLeft()) return left(restored.value)
    const title = await scope.titles.findByOriginForUpdate('payable', returned.receiptId)
    if (title?.status !== 'draft') return right('ignored')
    const reason = Reason.create('The delivery was returned to the supplier')
    if (reason.isLeft()) return left(reason.value)
    const cancelled = title.cancel(reason.value, now)
    if (cancelled.isLeft()) return right('ignored')
    await scope.titles.save(title)
    await append(
      scope,
      PROCUREMENT_ACTOR,
      'payable.withdrawn-with-return',
      title.id.toString(),
      now,
      { orderId: returned.orderId, receiptId: returned.receiptId },
    )
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
    await append(scope, PROCUREMENT_ACTOR, 'payable.forecast-withdrawn', title.id.toString(), now, {
      orderId,
    })
    return 'withdrawn'
  }
}

/** What the order still expects after a delivery, or after one came back. */
function forecastOf(
  orderId: string,
  movement: { remaining: WireMoney; remainingInstallments: readonly WireInstallment[] },
  now: Date,
) {
  return {
    direction: 'payable' as const,
    documentId: orderId,
    remaining: movement.remaining,
    installments: movement.remainingInstallments,
    actor: PROCUREMENT_ACTOR,
    subject: 'payable',
    settled: 'Everything this order committed to has arrived',
    now,
  }
}
