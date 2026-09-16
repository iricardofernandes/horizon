import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { Title } from '@/domain/entities/title'
import { BusinessDate, Currency, Money } from '@/domain/value-objects/financial-values'
import { DocumentNumber, Reason } from '@/domain/value-objects/title-values'
import type { Clock } from '../ports/clock'
import type { FinancialScope } from '../ports/unit-of-work'

const SALES_ACTOR = 'system:sales'

export interface ConfirmedOrder {
  readonly orderId: string
  readonly customerId: string
  readonly confirmedAt: string
  readonly total: { readonly amount: string; readonly currency: string }
}

/**
 * A confirmed sales order becomes a draft receivable: Sales knows what was sold, Financial
 * decides how and when it is collected. A person reviews the schedule and the category and
 * posts it. Redelivery of the same confirmation never raises a second title.
 */
export class RaiseReceivableFromOrderUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: FinancialScope,
    order: ConfirmedOrder,
  ): Promise<Either<InvalidInputError, 'raised' | 'ignored'>> {
    if (await scope.titles.findByOrderForUpdate('receivable', order.orderId))
      return right('ignored')
    const currency = Currency.create(order.total.currency)
    if (currency.isLeft()) return left(currency.value)
    const total = Money.create(order.total.amount, currency.value)
    if (total.isLeft()) return left(total.value)
    const issuedOn = BusinessDate.create(order.confirmedAt.slice(0, 10), '/confirmedAt')
    if (issuedOn.isLeft()) return left(issuedOn.value)
    const documentNumber = DocumentNumber.create(`SO-${order.orderId.slice(-8).toUpperCase()}`)
    if (documentNumber.isLeft()) return left(documentNumber.value)
    const now = this.clock.now()
    const title = Title.draft({
      tenantId: scope.tenantId,
      direction: 'receivable',
      origin: { type: 'sales-order', orderId: order.orderId },
      terms: {
        partyId: order.customerId,
        documentNumber: documentNumber.value,
        description: null,
        currency: currency.value,
        categoryId: null,
        issuedOn: issuedOn.value,
        competenceOn: issuedOn.value,
        installments: [{ dueOn: issuedOn.value, amount: total.value }],
        allocations: [],
      },
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
      },
    })
    return right('raised')
  }
}

/**
 * A cancelled order withdraws its draft receivable. A receivable already posted is a claim
 * someone accepted; only a person may reverse it, so it is left alone.
 */
export class WithdrawReceivableOfOrderUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(scope: FinancialScope, orderId: string): Promise<'withdrawn' | 'ignored'> {
    const title = await scope.titles.findByOrderForUpdate('receivable', orderId)
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
