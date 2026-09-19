import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import {
  Title,
  type TitleDirection,
  type TitleOrigin,
  type TitleTerms,
} from '@/domain/entities/title'
import { BusinessDate, Currency, Money } from '@/domain/value-objects/financial-values'
import { DocumentNumber, Reason } from '@/domain/value-objects/title-values'
import type { FinancialScope } from '../ports/unit-of-work'

export interface WireMoney {
  readonly amount: string
  readonly currency: string
}

export interface WireInstallment {
  readonly number: number
  readonly dueOn: string
  readonly amount: WireMoney
}

export interface RaiseInput {
  readonly direction: TitleDirection
  readonly origin: TitleOrigin
  readonly reference: string
  readonly partyId: string
  readonly issuedOn: string
  readonly currency: string
  readonly installments: readonly WireInstallment[]
  readonly stage: 'forecast' | 'effective'
  readonly actor: string
  readonly action: string
  readonly details: Readonly<Record<string, unknown>>
  readonly now: Date
}

/** Draft the title a document raised, at the stage that document is entitled to claim. */
export async function raise(
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
    direction: input.direction,
    origin: input.origin,
    terms,
    stage: input.stage,
    now: input.now,
  })
  if (title.isLeft()) return left(title.value)
  await scope.titles.create(title.value)
  await append(scope, input.actor, input.action, title.value.id.toString(), input.now, {
    ...input.details,
    total: title.value.total().amount.toString(),
    currency: currency.value.value,
    stage: input.stage,
  })
  return right('raised')
}

export interface ForecastChange {
  readonly direction: TitleDirection
  readonly documentId: string
  readonly remaining: WireMoney
  readonly installments: readonly WireInstallment[]
  readonly actor: string
  /** Prefix of the audit actions this change writes, `payable` or `receivable`. */
  readonly subject: string
  /** Why the forecast is closed when the document has nothing left to expect. */
  readonly settled: string
  readonly now: Date
}

/**
 * Leave a document's forecast showing exactly what is still committed and has not moved.
 *
 * When nothing is left it is cancelled rather than kept at zero, because a forecast of
 * nothing is not something anybody needs to read — and it can come back, because goods
 * that were returned are goods somebody still owes.
 */
export async function reduceForecast(
  scope: FinancialScope,
  change: ForecastChange,
): Promise<Either<InvalidInputError, 'reduced' | 'withdrawn' | 'ignored'>> {
  const forecast = await scope.titles.findByOriginForUpdate(change.direction, change.documentId)
  if (forecast?.stage !== 'forecast') return right('ignored')
  const wanted = change.remaining.amount !== '0' && change.installments.length > 0
  // A commitment can come back: goods that went back are goods somebody still owes.
  if (wanted && forecast.status === 'cancelled' && forecast.reinstate(change.now).isLeft())
    return right('ignored')
  if (forecast.status !== 'draft') return right('ignored')
  if (!wanted) {
    const reason = Reason.create(change.settled)
    if (reason.isLeft()) return left(reason.value)
    const cancelled = forecast.cancel(reason.value, change.now)
    if (cancelled.isLeft()) return right('ignored')
    await scope.titles.save(forecast)
    await append(
      scope,
      change.actor,
      `${change.subject}.forecast-withdrawn`,
      forecast.id.toString(),
      change.now,
      { documentId: change.documentId },
    )
    return right('withdrawn')
  }
  const schedule = scheduleOf(change.installments, forecast.currency)
  if (schedule.isLeft()) return left(schedule.value)
  const revised = forecast.revise(
    { ...forecast.termsOf(), installments: schedule.value },
    change.now,
  )
  if (revised.isLeft()) return right('ignored')
  await scope.titles.save(forecast)
  await append(
    scope,
    change.actor,
    `${change.subject}.forecast-reduced`,
    forecast.id.toString(),
    change.now,
    { documentId: change.documentId, remaining: change.remaining.amount },
  )
  return right('reduced')
}

export function scheduleOf(
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

export function append(
  scope: FinancialScope,
  actor: string,
  action: string,
  subjectId: string,
  occurredAt: Date,
  details: Readonly<Record<string, unknown>>,
) {
  return scope.audit.append({
    actor,
    action,
    subjectType: 'title',
    subjectId,
    occurredAt,
    requestId: null,
    details,
  })
}
