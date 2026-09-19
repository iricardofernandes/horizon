import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import {
  moneyPayload,
  originPayload,
  SettlementRecordedEvent,
  SettlementReversedEvent,
  TitlePostedEvent,
  TitleReversedEvent,
} from '../events/title-events'
import { Allocation, type AllocationEntry } from '../value-objects/allocation'
import type { BusinessDate, Currency } from '../value-objects/financial-values'
import { Money } from '../value-objects/financial-values'
import {
  type ApprovalState,
  NO_APPROVAL,
  type TitleApproval,
} from '../value-objects/title-approval'
import type { DocumentNumber, Memo, Reason } from '../value-objects/title-values'

export const TITLE_DIRECTIONS = ['receivable', 'payable'] as const
export type TitleDirection = (typeof TITLE_DIRECTIONS)[number]

export const TITLE_STATUSES = ['draft', 'posted', 'cancelled', 'reversed'] as const
export type TitleStatus = (typeof TITLE_STATUSES)[number]

/**
 * How firm the title is.
 *
 * A forecast is money the workspace expects: an order confirmed but not yet invoiced, a
 * cost committed but not yet incurred. It is not a claim on anyone, so it never posts,
 * never counts as a receivable or a payable, and never reaches the ledger — it exists to
 * be seen in what is coming. Invoicing turns the same title effective rather than raising
 * a second one, which is what makes duplication impossible rather than merely unlikely.
 */
export const TITLE_STAGES = ['forecast', 'effective'] as const
export type TitleStage = (typeof TITLE_STAGES)[number]

export const SETTLEMENT_STATES = ['open', 'partially-settled', 'settled'] as const
export type SettlementState = (typeof SETTLEMENT_STATES)[number]

export const MAX_TITLE_INSTALLMENTS = 120

/**
 * The document this title came from, when it came from one.
 *
 * A sales order and a purchase order raise a forecast; a goods receipt and a shipment
 * raise what is actually owed for what moved. The identifier is the document's own, so a
 * redelivery of the event that announced it always resolves to the same title.
 */
export const TITLE_ORIGINS = [
  'manual',
  'sales-order',
  'purchase-order',
  'purchase-receipt',
  'sales-shipment',
] as const
export type TitleOriginType = (typeof TITLE_ORIGINS)[number]

export type TitleOrigin =
  | { readonly type: 'manual' }
  | { readonly type: Exclude<TitleOriginType, 'manual'>; readonly documentId: string }

export interface Installment {
  readonly number: number
  readonly dueOn: BusinessDate
  readonly amount: Money
}

export interface Settlement {
  readonly id: string
  readonly installmentNumber: number
  readonly settledOn: BusinessDate
  /** Cash that actually moved. */
  readonly received: Money
  /** Reduces what is owed without cash. */
  readonly discount: Money
  /** Added to what is owed, and paid in the same settlement. */
  readonly interest: Money
  readonly penalty: Money
  readonly paymentMethodId: string | null
  /** The treasury account the cash moved through, when known. */
  readonly treasuryAccountId: string | null
  readonly recordedAt: Date
  readonly reversal: { readonly at: Date; readonly reason: Reason } | null
}

/** What a draft may say, and what a revision replaces wholesale. */
export interface TitleTerms {
  readonly partyId: string
  readonly documentNumber: DocumentNumber
  readonly description: Memo | null
  readonly currency: Currency
  readonly categoryId: string | null
  readonly issuedOn: BusinessDate
  readonly competenceOn: BusinessDate
  readonly installments: readonly { readonly dueOn: BusinessDate; readonly amount: Money }[]
  readonly allocations: readonly AllocationEntry[]
}

export interface SettlementInput {
  readonly installmentNumber: number
  readonly settledOn: BusinessDate
  readonly received: Money
  readonly discount: Money
  readonly interest: Money
  readonly penalty: Money
  readonly paymentMethodId: string | null
  /** The treasury account the cash moved through, when known. */
  readonly treasuryAccountId: string | null
}

interface TitleProps {
  tenantId: string
  direction: TitleDirection
  origin: TitleOrigin
  partyId: string
  documentNumber: DocumentNumber
  description: Memo | null
  currency: Currency
  categoryId: string | null
  issuedOn: BusinessDate
  competenceOn: BusinessDate
  installments: readonly Installment[]
  allocations: readonly AllocationEntry[]
  status: TitleStatus
  stage: TitleStage
  realisedAt: Date | null
  settlements: readonly Settlement[]
  postedAt: Date | null
  closure: { readonly at: Date; readonly reason: Reason } | null
  approval: TitleApproval
  createdAt: Date
  updatedAt: Date
}

export interface InstallmentSnapshot {
  readonly number: number
  readonly dueOn: string
  readonly amount: string
  readonly outstanding: string
  readonly state: SettlementState
}

export interface SettlementSnapshot {
  readonly id: string
  readonly installmentNumber: number
  readonly settledOn: string
  readonly received: string
  readonly discount: string
  readonly interest: string
  readonly penalty: string
  readonly paymentMethodId: string | null
  readonly treasuryAccountId: string | null
  readonly recordedAt: Date
  readonly reversedAt: Date | null
  readonly reversalReason: string | null
}

export interface TitleSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly direction: TitleDirection
  readonly origin: TitleOrigin
  readonly partyId: string
  readonly documentNumber: string
  readonly description: string | null
  readonly currency: string
  readonly categoryId: string | null
  readonly issuedOn: string
  readonly competenceOn: string
  readonly status: TitleStatus
  readonly stage: TitleStage
  readonly realisedAt: Date | null
  readonly settlementState: SettlementState
  readonly total: string
  readonly outstanding: string
  readonly installments: readonly InstallmentSnapshot[]
  readonly allocations: readonly { readonly dimensionId: string; readonly basisPoints: number }[]
  readonly settlements: readonly SettlementSnapshot[]
  readonly postedAt: Date | null
  readonly closedAt: Date | null
  readonly closureReason: string | null
  readonly approvalState: ApprovalState
  readonly approvalRequestedBy: string | null
  readonly approvalRequestedAt: Date | null
  readonly approvalDecidedBy: string | null
  readonly approvalDecidedAt: Date | null
  readonly approvalReason: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type TitleRehydration = TitleProps

/**
 * A payable or receivable: one claim, split into installments, settled over time.
 *
 * A draft is a working document and may be revised or cancelled. Posting makes it a fact
 * other contexts act on, so from then on nothing is edited away: a settlement is undone by
 * reversing it and a title by reversing it, and both stay in the record (ADR 0042).
 *
 * The balance of every installment is derived, never stored as the source of truth:
 * `amount + interest + penalty − received − discount` over settlements still in force. The
 * aggregate refuses any change that would make it negative.
 */
export class Title extends AggregateRoot<TitleProps> {
  static draft(
    props: {
      tenantId: string
      direction: TitleDirection
      origin: TitleOrigin
      terms: TitleTerms
      stage?: TitleStage
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<InvalidInputError, Title> {
    const installments = scheduleOf(props.terms)
    if (installments.isLeft()) return left(installments.value)
    return right(
      new Title(
        {
          tenantId: props.tenantId,
          direction: props.direction,
          origin: props.origin,
          ...termsProps(props.terms),
          installments: installments.value,
          status: 'draft',
          stage: props.stage ?? 'effective',
          realisedAt: null,
          settlements: [],
          postedAt: null,
          closure: null,
          approval: NO_APPROVAL,
          createdAt: props.now,
          updatedAt: props.now,
        },
        id,
      ),
    )
  }

  static rehydrate(props: TitleRehydration, id: UniqueEntityID): Title {
    return new Title(props, id)
  }

  get tenantId(): string {
    return this.props.tenantId
  }

  get direction(): TitleDirection {
    return this.props.direction
  }

  /** The terms as they stand, ready to be handed back with one of them changed. */
  termsOf(): TitleTerms {
    return {
      partyId: this.props.partyId,
      documentNumber: this.props.documentNumber,
      description: this.props.description,
      currency: this.props.currency,
      categoryId: this.props.categoryId,
      issuedOn: this.props.issuedOn,
      competenceOn: this.props.competenceOn,
      installments: this.props.installments.map((installment) => ({
        dueOn: installment.dueOn,
        amount: installment.amount,
      })),
      allocations: this.props.allocations,
    }
  }

  get stage(): TitleStage {
    return this.props.stage
  }

  get status(): TitleStatus {
    return this.props.status
  }

  get partyId(): string {
    return this.props.partyId
  }

  get origin(): TitleOrigin {
    return this.props.origin
  }

  get approvalState(): ApprovalState {
    return this.props.approval.state
  }

  get currency(): Currency {
    return this.props.currency
  }

  get categoryId(): string | null {
    return this.props.categoryId
  }

  get allocations(): readonly AllocationEntry[] {
    return this.props.allocations
  }

  revise(terms: TitleTerms, now: Date): Either<InvalidInputError | ConflictError, void> {
    if (this.props.status !== 'draft')
      return left(new ConflictError('only a draft can be revised; reverse a posted title instead'))
    const installments = scheduleOf(terms)
    if (installments.isLeft()) return left(installments.value)
    Object.assign(this.props, termsProps(terms), { installments: installments.value })
    // What was approved is no longer what is on the draft.
    this.props.approval = NO_APPROVAL
    this.props.updatedAt = now
    return right(undefined)
  }

  /**
   * Turn a forecast into an effective title, optionally on revised terms.
   *
   * It is the same aggregate throughout: the forecast is not closed and a second title
   * raised beside it, so there is never a moment when both exist and the same money is
   * counted twice. Invoicing may change the amount and the schedule, which is why terms
   * may be given.
   */
  realise(terms: TitleTerms | null, now: Date): Either<InvalidInputError | ConflictError, void> {
    if (this.props.stage !== 'forecast')
      return left(new ConflictError('this title is already effective'))
    if (this.props.status !== 'draft')
      return left(new ConflictError(`a ${this.props.status} forecast cannot be realised`))
    if (terms) {
      const installments = scheduleOf(terms)
      if (installments.isLeft()) return left(installments.value)
      Object.assign(this.props, termsProps(terms), { installments: installments.value })
      this.props.approval = NO_APPROVAL
    }
    this.props.stage = 'effective'
    this.props.realisedAt = now
    this.props.updatedAt = now
    return right(undefined)
  }

  /**
   * `approvalRequired` is the workspace policy's verdict on this title. A title that needs
   * approval posts only once approved; one that does not is recorded as exempt.
   */
  post(now: Date, policy: { approvalRequired: boolean }): Either<ConflictError, void> {
    if (this.props.status !== 'draft')
      return left(new ConflictError(`a ${this.props.status} title cannot be posted`))
    if (this.props.stage === 'forecast')
      return left(
        new ConflictError('a forecast is not a claim on anyone; realise it before posting it'),
      )
    if (this.props.categoryId === null)
      return left(new ConflictError('classify the title with a category before posting it'))
    if (policy.approvalRequired && this.props.approval.state !== 'approved')
      return left(new ConflictError('this title must be approved before it is posted'))
    if (!policy.approvalRequired && this.props.approval.state !== 'approved')
      this.props.approval = { ...NO_APPROVAL, state: 'not-required' }
    this.props.status = 'posted'
    this.props.postedAt = now
    this.props.updatedAt = now
    this.addDomainEvent(
      new TitlePostedEvent(this.id, this.props.tenantId, now, this.props.direction, {
        partyId: this.props.partyId,
        documentNumber: this.props.documentNumber.value,
        origin: originPayload(this.props.origin),
        categoryId: this.props.categoryId,
        issuedOn: this.props.issuedOn.value,
        competenceOn: this.props.competenceOn.value,
        total: moneyPayload(this.total()),
        installments: this.props.installments.map((installment) => ({
          number: installment.number,
          dueOn: installment.dueOn.value,
          amount: moneyPayload(installment.amount),
        })),
        allocations: this.props.allocations.map((entry) => ({
          dimensionId: entry.dimensionId,
          basisPoints: entry.share.basisPoints,
        })),
        postedAt: now.toISOString(),
      }),
    )
    return right(undefined)
  }

  requestApproval(actor: string, now: Date): Either<ConflictError, void> {
    if (this.props.direction !== 'payable')
      return left(new ConflictError('only payables go through approval'))
    if (this.props.status !== 'draft')
      return left(new ConflictError('only a draft can be sent for approval'))
    if (this.props.approval.state === 'pending' || this.props.approval.state === 'approved')
      return left(new ConflictError(`this payable is already ${this.props.approval.state}`))
    this.props.approval = { ...NO_APPROVAL, state: 'pending', requestedBy: actor, requestedAt: now }
    this.props.updatedAt = now
    return right(undefined)
  }

  /** Four eyes: whoever asked for approval cannot give it or refuse it. */
  approve(actor: string, now: Date): Either<ConflictError, void> {
    const decidable = this.decidable(actor)
    if (decidable.isLeft()) return decidable
    this.props.approval = {
      ...this.props.approval,
      state: 'approved',
      decidedBy: actor,
      decidedAt: now,
    }
    this.props.updatedAt = now
    return right(undefined)
  }

  reject(actor: string, reason: Reason, now: Date): Either<ConflictError, void> {
    const decidable = this.decidable(actor)
    if (decidable.isLeft()) return decidable
    this.props.approval = {
      ...this.props.approval,
      state: 'rejected',
      decidedBy: actor,
      decidedAt: now,
      reason,
    }
    this.props.updatedAt = now
    return right(undefined)
  }

  private decidable(actor: string): Either<ConflictError, void> {
    if (this.props.status !== 'draft' || this.props.approval.state !== 'pending')
      return left(new ConflictError('there is no pending approval to decide'))
    if (this.props.approval.requestedBy === actor)
      return left(new ConflictError('the person who requested approval cannot decide it'))
    return right(undefined)
  }

  /** A draft that will never be posted. Nothing was published, so nothing is announced. */
  cancel(reason: Reason, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'draft')
      return left(new ConflictError('only a draft can be cancelled; reverse a posted title'))
    this.props.status = 'cancelled'
    this.props.closure = { at: now, reason }
    this.props.updatedAt = now
    return right(undefined)
  }

  /**
   * A withdrawn draft that is wanted again.
   *
   * Only ever a draft, and only ever one that was cancelled: nothing was posted, so nothing
   * anybody acted on is being rewritten (ADR 0042). It exists because a commitment can come
   * back — a delivery returned to its supplier is a delivery the supplier still owes — and
   * the alternative would be a second title for the same document.
   */
  reinstate(now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'cancelled')
      return left(new ConflictError(`a ${this.props.status} title cannot be reinstated`))
    if (this.props.postedAt !== null)
      return left(new ConflictError('a title that was once posted is reversed, never reinstated'))
    this.props.status = 'draft'
    this.props.closure = null
    this.props.updatedAt = now
    return right(undefined)
  }

  reverse(reason: Reason, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'posted')
      return left(new ConflictError(`a ${this.props.status} title cannot be reversed`))
    if (this.activeSettlements().length > 0)
      return left(new ConflictError('reverse the settlements in force before the title'))
    this.props.status = 'reversed'
    this.props.closure = { at: now, reason }
    this.props.updatedAt = now
    this.addDomainEvent(
      new TitleReversedEvent(this.id, this.props.tenantId, now, this.props.direction, {
        partyId: this.props.partyId,
        reason: reason.value,
      }),
    )
    return right(undefined)
  }

  settle(
    input: SettlementInput,
    now: Date,
    settlementId = new UniqueEntityID().toString(),
  ): Either<InvalidInputError | ConflictError | ResourceNotFoundError, Settlement> {
    if (this.props.status !== 'posted')
      return left(new ConflictError(`a ${this.props.status} title cannot be settled`))
    const installment = this.props.installments.find(
      (candidate) => candidate.number === input.installmentNumber,
    )
    if (!installment)
      return left(
        new ResourceNotFoundError(`installment ${input.installmentNumber} does not exist`),
      )
    const amounts = [input.received, input.discount, input.interest, input.penalty]
    if (amounts.some((amount) => !amount.currency.equals(this.props.currency)))
      return left(
        new InvalidInputError('/currency', `settlements must be in ${this.props.currency.value}`),
      )
    if (input.settledOn.value < this.props.issuedOn.value)
      return left(new InvalidInputError('/settledOn', 'cannot precede the issue date'))
    const reduction = input.received.amount + input.discount.amount
    if (reduction === 0n)
      return left(
        new InvalidInputError('/received', 'a settlement must receive or discount something'),
      )
    const available =
      this.outstandingOf(installment.number) + input.interest.amount + input.penalty.amount
    if (reduction > available)
      return left(
        new ConflictError(
          'the settlement exceeds what the installment still owes; overpayments are not accepted',
        ),
      )
    const settlement: Settlement = {
      id: settlementId,
      ...input,
      recordedAt: now,
      reversal: null,
    }
    this.props.settlements = [...this.props.settlements, settlement]
    this.props.updatedAt = now
    this.addDomainEvent(
      new SettlementRecordedEvent(this.id, this.props.tenantId, now, {
        settlementId,
        direction: this.props.direction,
        partyId: this.props.partyId,
        documentNumber: this.props.documentNumber.value,
        installmentNumber: input.installmentNumber,
        settledOn: input.settledOn.value,
        received: moneyPayload(input.received),
        discount: moneyPayload(input.discount),
        interest: moneyPayload(input.interest),
        penalty: moneyPayload(input.penalty),
        paymentMethodId: input.paymentMethodId,
        ...(input.treasuryAccountId ? { treasuryAccountId: input.treasuryAccountId } : {}),
        outstanding: moneyPayload(this.outstanding()),
      }),
    )
    return right(settlement)
  }

  reverseSettlement(
    settlementId: string,
    reason: Reason,
    now: Date,
  ): Either<ConflictError | ResourceNotFoundError, void> {
    const settlement = this.props.settlements.find((candidate) => candidate.id === settlementId)
    if (!settlement) return left(new ResourceNotFoundError('settlement was not found'))
    if (settlement.reversal) return left(new ConflictError('settlement is already reversed'))
    if (this.props.status !== 'posted')
      return left(new ConflictError(`a ${this.props.status} title cannot change`))
    // Undoing interest or a penalty lowers the balance; it may not dip below zero because a
    // later settlement already paid what this one had added.
    const effect =
      settlement.interest.amount +
      settlement.penalty.amount -
      settlement.received.amount -
      settlement.discount.amount
    if (this.outstandingOf(settlement.installmentNumber) - effect < 0n)
      return left(new ConflictError('reverse the later settlements of this installment first'))
    this.props.settlements = this.props.settlements.map((candidate) =>
      candidate.id === settlementId ? { ...candidate, reversal: { at: now, reason } } : candidate,
    )
    this.props.updatedAt = now
    this.addDomainEvent(
      new SettlementReversedEvent(this.id, this.props.tenantId, now, {
        settlementId,
        direction: this.props.direction,
        partyId: this.props.partyId,
        reason: reason.value,
        outstanding: moneyPayload(this.outstanding()),
      }),
    )
    return right(undefined)
  }

  total(): Money {
    return Money.of(
      this.props.installments.reduce((sum, installment) => sum + installment.amount.amount, 0n),
      this.props.currency,
    )
  }

  outstandingOf(installmentNumber: number): bigint {
    const installment = this.props.installments.find(
      (candidate) => candidate.number === installmentNumber,
    )
    if (!installment) return 0n
    return this.activeSettlements()
      .filter((settlement) => settlement.installmentNumber === installmentNumber)
      .reduce(
        (balance, settlement) =>
          balance +
          settlement.interest.amount +
          settlement.penalty.amount -
          settlement.received.amount -
          settlement.discount.amount,
        installment.amount.amount,
      )
  }

  outstanding(): Money {
    return Money.of(
      this.props.installments.reduce(
        (sum, installment) => sum + this.outstandingOf(installment.number),
        0n,
      ),
      this.props.currency,
    )
  }

  settlementState(): SettlementState {
    return this.stateOf(this.outstanding().amount, this.activeSettlements().length > 0)
  }

  toSnapshot(): Readonly<TitleSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      direction: this.props.direction,
      origin: this.props.origin,
      partyId: this.props.partyId,
      documentNumber: this.props.documentNumber.value,
      description: this.props.description?.value ?? null,
      currency: this.props.currency.value,
      categoryId: this.props.categoryId,
      issuedOn: this.props.issuedOn.value,
      competenceOn: this.props.competenceOn.value,
      status: this.props.status,
      stage: this.props.stage,
      realisedAt: this.props.realisedAt,
      settlementState: this.settlementState(),
      total: this.total().amount.toString(),
      outstanding: this.outstanding().amount.toString(),
      installments: this.props.installments.map((installment) => {
        const outstanding = this.outstandingOf(installment.number)
        return {
          number: installment.number,
          dueOn: installment.dueOn.value,
          amount: installment.amount.amount.toString(),
          outstanding: outstanding.toString(),
          state: this.stateOf(
            outstanding,
            this.activeSettlements().some(
              (settlement) => settlement.installmentNumber === installment.number,
            ),
          ),
        }
      }),
      allocations: this.props.allocations.map((entry) => ({
        dimensionId: entry.dimensionId,
        basisPoints: entry.share.basisPoints,
      })),
      settlements: this.props.settlements.map((settlement) => ({
        id: settlement.id,
        installmentNumber: settlement.installmentNumber,
        settledOn: settlement.settledOn.value,
        received: settlement.received.amount.toString(),
        discount: settlement.discount.amount.toString(),
        interest: settlement.interest.amount.toString(),
        penalty: settlement.penalty.amount.toString(),
        paymentMethodId: settlement.paymentMethodId,
        treasuryAccountId: settlement.treasuryAccountId,
        recordedAt: settlement.recordedAt,
        reversedAt: settlement.reversal?.at ?? null,
        reversalReason: settlement.reversal?.reason.value ?? null,
      })),
      postedAt: this.props.postedAt,
      closedAt: this.props.closure?.at ?? null,
      closureReason: this.props.closure?.reason.value ?? null,
      approvalState: this.props.approval.state,
      approvalRequestedBy: this.props.approval.requestedBy,
      approvalRequestedAt: this.props.approval.requestedAt,
      approvalDecidedBy: this.props.approval.decidedBy,
      approvalDecidedAt: this.props.approval.decidedAt,
      approvalReason: this.props.approval.reason?.value ?? null,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }

  private activeSettlements(): readonly Settlement[] {
    return this.props.settlements.filter((settlement) => settlement.reversal === null)
  }

  private stateOf(outstanding: bigint, touched: boolean): SettlementState {
    if (this.props.status === 'posted' && outstanding === 0n) return 'settled'
    return touched ? 'partially-settled' : 'open'
  }
}

function termsProps(terms: TitleTerms) {
  return {
    partyId: terms.partyId,
    documentNumber: terms.documentNumber,
    description: terms.description,
    currency: terms.currency,
    categoryId: terms.categoryId,
    issuedOn: terms.issuedOn,
    competenceOn: terms.competenceOn,
    allocations: [...terms.allocations],
  }
}

function scheduleOf(terms: TitleTerms): Either<InvalidInputError, Installment[]> {
  const rows = terms.installments
  if (rows.length < 1 || rows.length > MAX_TITLE_INSTALLMENTS)
    return left(
      new InvalidInputError(
        '/installments',
        `must contain between 1 and ${MAX_TITLE_INSTALLMENTS} installments`,
      ),
    )
  for (const [index, row] of rows.entries()) {
    if (!row.amount.currency.equals(terms.currency))
      return left(
        new InvalidInputError(
          `/installments/${index}/amount`,
          `must be in ${terms.currency.value}`,
        ),
      )
    if (row.amount.amount === 0n)
      return left(
        new InvalidInputError(`/installments/${index}/amount`, 'must be greater than zero'),
      )
    if (row.dueOn.value < terms.issuedOn.value)
      return left(
        new InvalidInputError(
          `/installments/${index}/dueOn`,
          'cannot fall due before the issue date',
        ),
      )
    const previous = rows[index - 1]
    if (previous && row.dueOn.value < previous.dueOn.value)
      return left(
        new InvalidInputError(
          `/installments/${index}/dueOn`,
          'installments cannot fall due before the one preceding them',
        ),
      )
  }
  if (terms.allocations.length > 0) {
    const allocation = Allocation.of(terms.allocations)
    if (allocation.isLeft()) return left(allocation.value)
  }
  return right(
    rows.map((row, index) => ({ number: index + 1, dueOn: row.dueOn, amount: row.amount })),
  )
}
