import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { Reason } from '@/domain/value-objects/title-values'
import type { Clock } from '../ports/clock'
import type { FinancialScope } from '../ports/unit-of-work'
import { append, raise, type WireInstallment, type WireMoney } from './title-flows'

const SALES_ACTOR = 'system:sales'

export interface DeliveredService {
  readonly serviceOrderId: string
  readonly deliveryId: string
  readonly customerId: string
  readonly performedOn: string
  readonly value: WireMoney
  readonly installments: readonly WireInstallment[]
}

/**
 * Work was delivered, so what it billed is owed (ADR 0056).
 *
 * One receivable per delivery, keyed by the delivery: a replay of the same fact, or the
 * same facts under a new event id, finds the title already there and raises nothing.
 */
export class RecordReceivableFromServiceDeliveryUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: FinancialScope,
    delivery: DeliveredService,
  ): Promise<Either<InvalidInputError, 'raised' | 'ignored'>> {
    if (await scope.titles.findByOriginForUpdate('receivable', delivery.deliveryId))
      return right('ignored')
    return raise(scope, {
      direction: 'receivable',
      actor: SALES_ACTOR,
      origin: { type: 'sales-service-delivery', documentId: delivery.deliveryId },
      reference: `SV-${delivery.deliveryId.slice(-8).toUpperCase()}`,
      partyId: delivery.customerId,
      issuedOn: delivery.performedOn,
      currency: delivery.value.currency,
      installments: delivery.installments,
      stage: 'effective',
      action: 'receivable.raised-from-service-delivery',
      details: { serviceOrderId: delivery.serviceOrderId, deliveryId: delivery.deliveryId },
      now: this.clock.now(),
    })
  }
}

export interface CancelledServiceDelivery {
  readonly serviceOrderId: string
  readonly deliveryId: string
  readonly reason: string
}

/** A cancellation that arrived before the delivery it cancels; the broker retries it. */
export class DeliveryNotYetReceived extends Error {}

/**
 * The service was not provided after all, so the claim it raised goes with it.
 *
 * A draft is withdrawn. A posted receivable is reversed, because there is nothing left to
 * claim — unlike returned goods, which a person still has to settle (ADR 0042). Once money
 * has been received against it, the reversal is a person's decision: the title is left as
 * it is and the audit log says it needs one.
 */
export class WithdrawReceivableOfServiceDeliveryUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: FinancialScope,
    cancelled: CancelledServiceDelivery,
  ): Promise<Either<InvalidInputError, 'withdrawn' | 'reversed' | 'flagged' | 'ignored'>> {
    const title = await scope.titles.findByOriginForUpdate('receivable', cancelled.deliveryId)
    if (!title)
      throw new DeliveryNotYetReceived('the receivable of this delivery has not been raised yet')
    const reason = Reason.create(`Service not provided: ${cancelled.reason}`.slice(0, 500))
    if (reason.isLeft()) return left(reason.value)
    const now = this.clock.now()
    const details = { serviceOrderId: cancelled.serviceOrderId, deliveryId: cancelled.deliveryId }
    const subject = title.id.toString()
    if (title.status === 'draft') {
      if (title.cancel(reason.value, now).isLeft()) return right('ignored')
      await scope.titles.save(title)
      await append(scope, SALES_ACTOR, 'receivable.withdrawn-with-service', subject, now, details)
      return right('withdrawn')
    }
    if (title.status !== 'posted') return right('ignored')
    if (title.reverse(reason.value, now).isLeft()) {
      await append(
        scope,
        SALES_ACTOR,
        'receivable.service-cancellation-needs-review',
        subject,
        now,
        {
          ...details,
          why: 'money was already received against this receivable',
        },
      )
      return right('flagged')
    }
    await scope.titles.save(title)
    await append(scope, SALES_ACTOR, 'receivable.reversed-with-service', subject, now, details)
    return right('reversed')
  }
}
