import { createHash } from 'node:crypto'
import { canonicalJson } from '@/core/audit/canonical-json'
import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { SettlementInput, TitleDirection, TitleTerms } from '@/domain/entities/title'
import type { AllocationEntry } from '@/domain/value-objects/allocation'
import { BusinessDate, Currency, Money, Share } from '@/domain/value-objects/financial-values'
import { DocumentNumber, Memo, Reason } from '@/domain/value-objects/title-values'
import type { FinancialScope } from '../ports/unit-of-work'

/** Who asked, and how to find the request again in logs and traces. */
export interface CommandContext {
  readonly tenantId: string
  readonly actor: string
  readonly requestId: string | null
}

export interface IdempotentContext extends CommandContext {
  readonly idempotencyKey: string
}

export interface TermsInput {
  readonly partyId: string
  readonly documentNumber: string
  readonly description?: string | undefined
  readonly currency: string
  readonly categoryId?: string | null | undefined
  readonly issuedOn: string
  readonly competenceOn?: string | undefined
  readonly installments: readonly { readonly dueOn: string; readonly amount: string }[]
  readonly allocations?:
    | readonly { readonly dimensionId: string; readonly percentage: string }[]
    | undefined
}

export interface SettlementRequest {
  readonly installmentNumber: number
  readonly settledOn: string
  readonly received: string
  readonly discount?: string | undefined
  readonly interest?: string | undefined
  readonly penalty?: string | undefined
  readonly paymentMethodId?: string | null | undefined
  readonly treasuryAccountId?: string | null | undefined
}

export type Failure = InvalidInputError | ConflictError | ResourceNotFoundError

export function fingerprintOf(command: string, request: unknown): string {
  return createHash('sha256').update(canonicalJson({ command, request })).digest('hex')
}

export function reasonOf(value: string): Either<InvalidInputError, Reason> {
  return Reason.create(value)
}

function amountOf(
  value: string,
  currency: Currency,
  field: string,
): Either<InvalidInputError, Money> {
  const money = Money.create(value, currency)
  return money.isLeft() ? left(new InvalidInputError(field, money.value.message)) : money
}

function dateOf(value: string, field: string): Either<InvalidInputError, BusinessDate> {
  return BusinessDate.create(value, field)
}

function installmentsOf(
  input: TermsInput,
  currency: Currency,
): Either<InvalidInputError, { dueOn: BusinessDate; amount: Money }[]> {
  const installments: { dueOn: BusinessDate; amount: Money }[] = []
  for (const [index, row] of input.installments.entries()) {
    const dueOn = dateOf(row.dueOn, `/installments/${index}/dueOn`)
    if (dueOn.isLeft()) return left(dueOn.value)
    const amount = amountOf(row.amount, currency, `/installments/${index}/amount`)
    if (amount.isLeft()) return left(amount.value)
    installments.push({ dueOn: dueOn.value, amount: amount.value })
  }
  return right(installments)
}

function allocationsOf(input: TermsInput): Either<InvalidInputError, AllocationEntry[]> {
  const allocations: AllocationEntry[] = []
  for (const [index, entry] of (input.allocations ?? []).entries()) {
    const share = Share.fromPercentage(entry.percentage, `/allocations/${index}/percentage`)
    if (share.isLeft()) return left(share.value)
    allocations.push({ dimensionId: entry.dimensionId, share: share.value })
  }
  return right(allocations)
}

/** Turn the wire shape of a title into domain values; structural checks only. */
export function termsOf(input: TermsInput): Either<InvalidInputError, TitleTerms> {
  const currency = Currency.create(input.currency)
  if (currency.isLeft()) return left(currency.value)
  const documentNumber = DocumentNumber.create(input.documentNumber)
  if (documentNumber.isLeft()) return left(documentNumber.value)
  const description = Memo.create(input.description ?? '')
  if (description.isLeft()) return left(description.value)
  const issuedOn = dateOf(input.issuedOn, '/issuedOn')
  if (issuedOn.isLeft()) return left(issuedOn.value)
  const competenceOn = dateOf(input.competenceOn ?? input.issuedOn, '/competenceOn')
  if (competenceOn.isLeft()) return left(competenceOn.value)
  const installments = installmentsOf(input, currency.value)
  if (installments.isLeft()) return left(installments.value)
  const allocations = allocationsOf(input)
  if (allocations.isLeft()) return left(allocations.value)
  return right({
    partyId: input.partyId,
    documentNumber: documentNumber.value,
    description: description.value,
    currency: currency.value,
    categoryId: input.categoryId ?? null,
    issuedOn: issuedOn.value,
    competenceOn: competenceOn.value,
    installments: installments.value,
    allocations: allocations.value,
  })
}

export function settlementOf(
  request: SettlementRequest,
  currency: Currency,
): Either<InvalidInputError, SettlementInput> {
  const settledOn = dateOf(request.settledOn, '/settledOn')
  if (settledOn.isLeft()) return left(settledOn.value)
  const parts: Money[] = []
  for (const [field, value] of [
    ['received', request.received],
    ['discount', request.discount ?? '0'],
    ['interest', request.interest ?? '0'],
    ['penalty', request.penalty ?? '0'],
  ] as const) {
    const amount = amountOf(value, currency, `/${field}`)
    if (amount.isLeft()) return left(amount.value)
    parts.push(amount.value)
  }
  const [received, discount, interest, penalty] = parts as [Money, Money, Money, Money]
  return right({
    installmentNumber: request.installmentNumber,
    settledOn: settledOn.value,
    received,
    discount,
    interest,
    penalty,
    paymentMethodId: request.paymentMethodId ?? null,
    treasuryAccountId: request.treasuryAccountId ?? null,
  })
}

const NATURE_OF: Readonly<Record<TitleDirection, 'revenue' | 'expense'>> = {
  receivable: 'revenue',
  payable: 'expense',
}
const ROLE_OF: Readonly<Record<TitleDirection, string>> = {
  receivable: 'customer',
  payable: 'supplier',
}

/** The party exists in this workspace, plays the role the direction needs and was not erased. */
export async function checkParty(
  scope: FinancialScope,
  direction: TitleDirection,
  partyId: string,
): Promise<Either<Failure, void>> {
  const party = await scope.parties.find(partyId)
  if (!party || party.erased) return left(new ResourceNotFoundError('party was not found'))
  if (!party.roles.includes(ROLE_OF[direction]))
    return left(new ConflictError(`the party is not registered as a ${ROLE_OF[direction]}`))
  return right(undefined)
}

/** Category, dimensions: present in this workspace, active, and of the right nature. */
export async function checkClassification(
  scope: FinancialScope,
  direction: TitleDirection,
  terms: { readonly categoryId: string | null; readonly allocations: readonly AllocationEntry[] },
): Promise<Either<Failure, void>> {
  if (terms.categoryId !== null) {
    const category = await scope.categories.findById(terms.categoryId)
    if (!category) return left(new ResourceNotFoundError('category was not found'))
    if (!category.isActive()) return left(new ConflictError('category is inactive'))
    if (category.nature !== NATURE_OF[direction])
      return left(new ConflictError(`a ${direction} must use a ${NATURE_OF[direction]} category`))
  }
  if (terms.allocations.length > 0) {
    const found = await scope.dimensions.findByIds(
      terms.allocations.map((entry) => entry.dimensionId),
    )
    const usable = new Set(found.filter((row) => row.isActive()).map((row) => row.id.toString()))
    const missing = terms.allocations.find((entry) => !usable.has(entry.dimensionId))
    if (missing)
      return left(
        new ResourceNotFoundError(`dimension ${missing.dimensionId} is not an active dimension`),
      )
  }
  return right(undefined)
}

export async function checkPaymentMethod(
  scope: FinancialScope,
  paymentMethodId: string | null,
): Promise<Either<Failure, void>> {
  if (paymentMethodId === null) return right(undefined)
  const method = await scope.paymentMethods.findById(paymentMethodId)
  if (!method) return left(new ResourceNotFoundError('payment method was not found'))
  if (!method.isActive()) return left(new ConflictError('payment method is inactive'))
  return right(undefined)
}
