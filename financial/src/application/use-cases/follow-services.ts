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

  executeInScope(
    scope: FinancialScope,
    cancelled: CancelledServiceDelivery,
  ): Promise<Either<InvalidInputError, Withdrawal>> {
    return withdrawBilledReceivable(scope, this.clock.now(), {
      documentId: cancelled.deliveryId,
      reason: `Service not provided: ${cancelled.reason}`,
      details: { serviceOrderId: cancelled.serviceOrderId, deliveryId: cancelled.deliveryId },
      actions: {
        withdrawn: 'receivable.withdrawn-with-service',
        reversed: 'receivable.reversed-with-service',
        flagged: 'receivable.service-cancellation-needs-review',
      },
      notYetReceived: () =>
        new DeliveryNotYetReceived('the receivable of this delivery has not been raised yet'),
    })
  }
}

export interface BilledContractPeriod {
  readonly contractId: string
  readonly billedPeriodId: string
  readonly customerId: string
  readonly competence: string
  readonly issuedOn: string
  readonly value: WireMoney
  readonly installments: readonly WireInstallment[]
}

/**
 * A contract period was billed, so what it billed is owed (Phase 52, ADR 0056).
 *
 * One receivable per billed period, keyed by it: a replay, or the same facts under a new
 * event id, finds the title already there and raises nothing.
 */
export class RecordReceivableFromContractPeriodUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: FinancialScope,
    period: BilledContractPeriod,
  ): Promise<Either<InvalidInputError, 'raised' | 'ignored'>> {
    if (await scope.titles.findByOriginForUpdate('receivable', period.billedPeriodId))
      return right('ignored')
    return raise(scope, {
      direction: 'receivable',
      actor: SALES_ACTOR,
      origin: { type: 'sales-contract-period', documentId: period.billedPeriodId },
      reference: `CT-${period.billedPeriodId.slice(-8).toUpperCase()}`,
      partyId: period.customerId,
      issuedOn: period.issuedOn,
      currency: period.value.currency,
      installments: period.installments,
      stage: 'effective',
      action: 'receivable.raised-from-contract-period',
      details: {
        contractId: period.contractId,
        billedPeriodId: period.billedPeriodId,
        competence: period.competence,
      },
      now: this.clock.now(),
    })
  }
}

export interface CreditedContractPeriod {
  readonly contractId: string
  readonly billedPeriodId: string
  readonly reasonCode: 'not-provided' | 'billing-error'
  readonly reason: string
}

/** A credit that arrived before the billed period it credits; the broker retries it. */
export class PeriodNotYetReceived extends Error {}

/**
 * A billed period was credited in full, so its receivable goes, exactly as for a delivery
 * that was not provided: withdrawn as a draft, reversed once posted, flagged once money
 * was received against it.
 */
export class WithdrawReceivableOfCreditedPeriodUseCase {
  constructor(private readonly clock: Clock) {}

  executeInScope(
    scope: FinancialScope,
    credited: CreditedContractPeriod,
  ): Promise<Either<InvalidInputError, Withdrawal>> {
    const why = credited.reasonCode === 'not-provided' ? 'Service not provided' : 'Billed in error'
    return withdrawBilledReceivable(scope, this.clock.now(), {
      documentId: credited.billedPeriodId,
      reason: `${why}: ${credited.reason}`,
      details: { contractId: credited.contractId, billedPeriodId: credited.billedPeriodId },
      actions: {
        withdrawn: 'receivable.withdrawn-with-credit',
        reversed: 'receivable.reversed-with-credit',
        flagged: 'receivable.credit-needs-review',
      },
      notYetReceived: () =>
        new PeriodNotYetReceived('the receivable of this period has not been raised yet'),
    })
  }
}

type Withdrawal = 'withdrawn' | 'reversed' | 'flagged' | 'ignored'

async function withdrawBilledReceivable(
  scope: FinancialScope,
  now: Date,
  input: {
    documentId: string
    reason: string
    details: Readonly<Record<string, unknown>>
    actions: Readonly<Record<'withdrawn' | 'reversed' | 'flagged', string>>
    notYetReceived: () => Error
  },
): Promise<Either<InvalidInputError, Withdrawal>> {
  const title = await scope.titles.findByOriginForUpdate('receivable', input.documentId)
  if (!title) throw input.notYetReceived()
  const reason = Reason.create(input.reason.slice(0, 500))
  if (reason.isLeft()) return left(reason.value)
  const subject = title.id.toString()
  if (title.status === 'draft') {
    if (title.cancel(reason.value, now).isLeft()) return right('ignored')
    await scope.titles.save(title)
    await append(scope, SALES_ACTOR, input.actions.withdrawn, subject, now, input.details)
    return right('withdrawn')
  }
  if (title.status !== 'posted') return right('ignored')
  if (title.reverse(reason.value, now).isLeft()) {
    await append(scope, SALES_ACTOR, input.actions.flagged, subject, now, {
      ...input.details,
      why: 'money was already received against this receivable',
    })
    return right('flagged')
  }
  await scope.titles.save(title)
  await append(scope, SALES_ACTOR, input.actions.reversed, subject, now, input.details)
  return right('reversed')
}
