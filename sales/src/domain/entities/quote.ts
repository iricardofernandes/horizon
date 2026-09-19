import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { QuoteAcceptedEvent, QuoteRejectedEvent, QuoteSentEvent } from '../events/sales-events'
import type {
  CarrierName,
  Currency,
  LineDescription,
  PaymentTerms,
  Quantity,
  Reason,
} from '../value-objects/sales-values'
import { Money } from '../value-objects/sales-values'

export const QUOTE_STATUSES = [
  'draft',
  'pending',
  'sent',
  'accepted',
  'rejected',
  'expired',
  'superseded',
] as const
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]

export const APPROVAL_STATES = ['none', 'pending', 'approved', 'rejected', 'not-required'] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]

export interface QuoteApproval {
  readonly state: ApprovalState
  readonly requestedBy: string | null
  readonly requestedAt: Date | null
  readonly decidedBy: string | null
  readonly decidedAt: Date | null
  readonly reason: Reason | null
}

export const NO_APPROVAL: QuoteApproval = Object.freeze({
  state: 'none',
  requestedBy: null,
  requestedAt: null,
  decidedBy: null,
  decidedAt: null,
  reason: null,
})

export interface QuoteLine {
  readonly lineId: string
  readonly itemId: string
  readonly quantity: Quantity
  readonly description: LineDescription
  readonly unitPrice: Money
  readonly lineTotal: Money
}

/** What the offer says beyond the goods themselves. */
export interface QuoteTerms {
  readonly sellerId: string | null
  readonly discount: Money
  readonly freight: Money
  readonly carrier: CarrierName | null
  readonly paymentTerms: PaymentTerms
  readonly notes: string | null
}

interface QuoteProps {
  tenantId: string
  /** The first version's id: every version of one offer shares it, and so shares a number. */
  rootId: string
  version: number
  customerId: string
  currency: Currency
  lines: readonly QuoteLine[]
  terms: QuoteTerms
  status: QuoteStatus
  approval: QuoteApproval
  expiresAt: Date
  supersedes: string | null
  supersededBy: string | null
  closure: Reason | null
  orderId: string | null
  sentAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface QuoteInput {
  readonly tenantId: string
  readonly customerId: string
  readonly currency: Currency
  readonly lines: readonly QuoteLine[]
  readonly terms: QuoteTerms
  readonly expiresAt: Date
  readonly now: Date
}

/**
 * An offer to a customer: these goods, at this price, until this date.
 *
 * A sent quote is never edited. Negotiating produces a **new version** of the same offer,
 * which supersedes the last one and keeps it — so the record shows what was actually put in
 * front of the customer and when, rather than only what was agreed in the end. Every
 * version shares the first one's identifier, which is what makes them one offer instead of
 * several unrelated ones.
 *
 * A discount deep enough to matter is somebody else's decision: the quote waits, and
 * whoever asked is not the one who may grant it.
 */
export class Quote extends AggregateRoot<QuoteProps> {
  static draft(input: QuoteInput, id?: UniqueEntityID): Either<InvalidInputError, Quote> {
    const checked = check(input.lines, input.terms, input.currency)
    if (checked.isLeft()) return left(checked.value)
    if (input.expiresAt.getTime() <= input.now.getTime())
      return left(new InvalidInputError('/expiresAt', 'a quote must expire after it is written'))
    const identity = id ?? new UniqueEntityID()
    return right(
      new Quote(
        {
          tenantId: input.tenantId,
          rootId: identity.toString(),
          version: 1,
          customerId: input.customerId,
          currency: input.currency,
          lines: input.lines,
          terms: input.terms,
          status: 'draft',
          approval: NO_APPROVAL,
          expiresAt: input.expiresAt,
          supersedes: null,
          supersededBy: null,
          closure: null,
          orderId: null,
          sentAt: null,
          createdAt: input.now,
          updatedAt: input.now,
        },
        identity,
      ),
    )
  }

  static rehydrate(props: QuoteProps, id: UniqueEntityID): Quote {
    return new Quote(props, id)
  }

  get tenantId(): string {
    return this.props.tenantId
  }

  get rootId(): string {
    return this.props.rootId
  }

  get version(): number {
    return this.props.version
  }

  get customerId(): string {
    return this.props.customerId
  }

  get currency(): Currency {
    return this.props.currency
  }

  get status(): QuoteStatus {
    return this.props.status
  }

  get approvalState(): ApprovalState {
    return this.props.approval.state
  }

  get expiresAt(): Date {
    return this.props.expiresAt
  }

  lines(): readonly QuoteLine[] {
    return this.props.lines
  }

  terms(): QuoteTerms {
    return this.props.terms
  }

  /** The goods alone, before freight and the discount. */
  net(): Money {
    return this.props.lines.reduce(
      (sum, line) => sum.plus(line.lineTotal),
      Money.fromAmount(0n, this.props.currency),
    )
  }

  total(): Money {
    return this.net().plus(this.props.terms.freight).minus(this.props.terms.discount)
  }

  /** How deep the discount is, against the goods it is taken off. */
  discountBasisPoints(): number {
    return this.props.terms.discount.basisPointsOf(this.net())
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  hasExpired(now: Date): boolean {
    return now.getTime() >= this.props.expiresAt.getTime()
  }

  revise(
    change: { lines: readonly QuoteLine[]; terms: QuoteTerms; expiresAt: Date },
    now: Date,
  ): Either<InvalidInputError | ConflictError, void> {
    if (this.props.status !== 'draft')
      return left(new ConflictError('only a draft quote can be revised; send a new version'))
    const checked = check(change.lines, change.terms, this.props.currency)
    if (checked.isLeft()) return left(checked.value)
    this.props.lines = change.lines
    this.props.terms = change.terms
    this.props.expiresAt = change.expiresAt
    this.props.approval = NO_APPROVAL
    this.props.updatedAt = now
    return right(undefined)
  }

  /**
   * Put the offer in front of the customer, or ask somebody whether we may.
   *
   * `approvalRequired` is the workspace's verdict on how deep the discount is. One that
   * needs a second person waits for them; one that does not records that nobody was asked,
   * so an audit can tell an exemption from an oversight.
   */
  send(
    actor: string,
    now: Date,
    policy: { readonly approvalRequired: boolean },
  ): Either<ConflictError, void> {
    if (this.props.status !== 'draft')
      return left(new ConflictError(`a ${this.props.status} quote cannot be sent`))
    if (this.hasExpired(now))
      return left(new ConflictError('this quote expired before it was sent'))
    if (policy.approvalRequired) {
      this.props.approval = {
        ...NO_APPROVAL,
        state: 'pending',
        requestedBy: actor,
        requestedAt: now,
      }
      this.props.status = 'pending'
      this.props.updatedAt = now
      return right(undefined)
    }
    this.props.approval = { ...NO_APPROVAL, state: 'not-required' }
    this.leave(now)
    return right(undefined)
  }

  /** Four eyes: whoever asked for the discount cannot be the one who grants it. */
  approve(actor: string, now: Date): Either<ConflictError, void> {
    const decidable = this.decidable(actor)
    if (decidable.isLeft()) return decidable
    this.props.approval = {
      ...this.props.approval,
      state: 'approved',
      decidedBy: actor,
      decidedAt: now,
    }
    this.leave(now)
    return right(undefined)
  }

  refuseApproval(actor: string, reason: Reason, now: Date): Either<ConflictError, void> {
    const decidable = this.decidable(actor)
    if (decidable.isLeft()) return decidable
    this.props.approval = {
      ...this.props.approval,
      state: 'rejected',
      decidedBy: actor,
      decidedAt: now,
      reason,
    }
    this.props.status = 'draft'
    this.props.updatedAt = now
    return right(undefined)
  }

  /** The customer said yes. Only an offer they were actually shown can be accepted. */
  accept(now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'sent')
      return left(new ConflictError(`a ${this.props.status} quote cannot be accepted`))
    if (this.hasExpired(now)) {
      this.props.status = 'expired'
      this.props.updatedAt = now
      return left(new ConflictError('this quote has expired'))
    }
    this.props.status = 'accepted'
    this.props.updatedAt = now
    this.addDomainEvent(
      new QuoteAcceptedEvent(this.id, this.props.tenantId, now, {
        quoteRoot: this.props.rootId,
        version: this.props.version,
        customerId: this.props.customerId,
        total: this.total(),
      }),
    )
    return right(undefined)
  }

  /** The customer said no, and why. A refusal is worth as much to a record as a yes. */
  decline(reason: Reason, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'sent' && this.props.status !== 'pending')
      return left(new ConflictError(`a ${this.props.status} quote cannot be declined`))
    this.props.status = 'rejected'
    this.props.closure = reason
    this.props.updatedAt = now
    this.addDomainEvent(
      new QuoteRejectedEvent(this.id, this.props.tenantId, now, {
        quoteRoot: this.props.rootId,
        version: this.props.version,
        customerId: this.props.customerId,
        reason: reason.value,
      }),
    )
    return right(undefined)
  }

  /** Nobody answered in time. Recorded rather than inferred, so a list can be read as it is. */
  expire(now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'sent' && this.props.status !== 'pending')
      return left(new ConflictError(`a ${this.props.status} quote does not expire`))
    if (!this.hasExpired(now)) return left(new ConflictError('this quote has not expired yet'))
    this.props.status = 'expired'
    this.props.updatedAt = now
    return right(undefined)
  }

  /** A newer version took this one's place. The offer stays; it is simply no longer current. */
  supersede(next: string, now: Date): Either<ConflictError, void> {
    if (this.props.status === 'accepted')
      return left(new ConflictError('an accepted quote cannot be superseded'))
    this.props.status = 'superseded'
    this.props.supersededBy = next
    this.props.updatedAt = now
    return right(undefined)
  }

  /** The order this offer turned into. One accepted quote becomes at most one order. */
  markOrdered(orderId: string, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'accepted')
      return left(new ConflictError('only an accepted quote becomes an order'))
    if (this.props.orderId) return left(new ConflictError('this quote has already become an order'))
    this.props.orderId = orderId
    this.props.updatedAt = now
    return right(undefined)
  }

  /**
   * The next version of this offer: same customer, same identity, a higher number.
   *
   * The caller supersedes this one in the same transaction, which is what keeps exactly one
   * version of an offer current at any moment.
   */
  nextVersion(
    change: { lines: readonly QuoteLine[]; terms: QuoteTerms; expiresAt: Date },
    now: Date,
    id?: UniqueEntityID,
  ): Either<InvalidInputError | ConflictError, Quote> {
    if (this.props.status === 'accepted')
      return left(new ConflictError('an accepted quote is the offer that was agreed'))
    const checked = check(change.lines, change.terms, this.props.currency)
    if (checked.isLeft()) return left(checked.value)
    if (change.expiresAt.getTime() <= now.getTime())
      return left(new InvalidInputError('/expiresAt', 'a quote must expire after it is written'))
    return right(
      new Quote(
        {
          tenantId: this.props.tenantId,
          rootId: this.props.rootId,
          version: this.props.version + 1,
          customerId: this.props.customerId,
          currency: this.props.currency,
          lines: change.lines,
          terms: change.terms,
          status: 'draft',
          approval: NO_APPROVAL,
          expiresAt: change.expiresAt,
          supersedes: this.id.toString(),
          supersededBy: null,
          closure: null,
          orderId: null,
          sentAt: null,
          createdAt: now,
          updatedAt: now,
        },
        id,
      ),
    )
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    rootId: string
    version: number
    customerId: string
    currency: string
    sellerId: string | null
    discount: string
    freight: string
    carrier: string | null
    paymentTermDays: readonly number[]
    notes: string | null
    net: string
    total: string
    status: QuoteStatus
    approvalState: ApprovalState
    approvalRequestedBy: string | null
    approvalRequestedAt: Date | null
    approvalDecidedBy: string | null
    approvalDecidedAt: Date | null
    approvalReason: string | null
    expiresAt: Date
    supersedes: string | null
    supersededBy: string | null
    closureReason: string | null
    orderId: string | null
    sentAt: Date | null
    createdAt: Date
    updatedAt: Date
    lines: readonly {
      lineId: string
      itemId: string
      quantity: string
      description: string
      unitPrice: string
      lineTotal: string
    }[]
  }> {
    const { terms } = this.props
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      rootId: this.props.rootId,
      version: this.props.version,
      customerId: this.props.customerId,
      currency: this.props.currency.value,
      sellerId: terms.sellerId,
      discount: terms.discount.amount.toString(),
      freight: terms.freight.amount.toString(),
      carrier: terms.carrier?.value ?? null,
      paymentTermDays: terms.paymentTerms.days,
      notes: terms.notes,
      net: this.net().amount.toString(),
      total: this.total().amount.toString(),
      status: this.props.status,
      approvalState: this.props.approval.state,
      approvalRequestedBy: this.props.approval.requestedBy,
      approvalRequestedAt: this.props.approval.requestedAt,
      approvalDecidedBy: this.props.approval.decidedBy,
      approvalDecidedAt: this.props.approval.decidedAt,
      approvalReason: this.props.approval.reason?.value ?? null,
      expiresAt: this.props.expiresAt,
      supersedes: this.props.supersedes,
      supersededBy: this.props.supersededBy,
      closureReason: this.props.closure?.value ?? null,
      orderId: this.props.orderId,
      sentAt: this.props.sentAt,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
      lines: this.props.lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        quantity: line.quantity.toString(),
        description: line.description.value,
        unitPrice: line.unitPrice.amount.toString(),
        lineTotal: line.lineTotal.amount.toString(),
      })),
    })
  }

  private leave(now: Date): void {
    this.props.status = 'sent'
    this.props.sentAt = now
    this.props.updatedAt = now
    this.addDomainEvent(
      new QuoteSentEvent(this.id, this.props.tenantId, now, {
        quoteRoot: this.props.rootId,
        version: this.props.version,
        customerId: this.props.customerId,
        total: this.total(),
        expiresAt: this.props.expiresAt,
      }),
    )
  }

  private decidable(actor: string): Either<ConflictError, void> {
    if (this.props.status !== 'pending' || this.props.approval.state !== 'pending')
      return left(new ConflictError('there is no pending approval to decide'))
    if (this.props.approval.requestedBy === actor)
      return left(new ConflictError('the person who asked for this discount cannot grant it'))
    return right(undefined)
  }
}

function check(
  lines: readonly QuoteLine[],
  terms: QuoteTerms,
  currency: Currency,
): Either<InvalidInputError, void> {
  if (lines.length === 0)
    return left(new InvalidInputError('/lines', 'a quote requires at least one line'))
  if (new Set(lines.map((line) => line.lineId)).size !== lines.length)
    return left(new InvalidInputError('/lines', 'line identifiers must be unique'))
  if (new Set(lines.map((line) => line.itemId)).size !== lines.length)
    return left(new InvalidInputError('/lines', 'quote each item once, in a single line'))
  if (lines.some((line) => line.quantity.isZero()))
    return left(new InvalidInputError('/lines/quantity', 'quoted quantities must be positive'))
  const mixed = [...lines.map((line) => line.unitPrice), terms.discount, terms.freight].some(
    (money) => !money.currency.equals(currency),
  )
  if (mixed)
    return left(new InvalidInputError('/currency', 'every amount must use the quote currency'))
  const net = lines.reduce((sum, line) => sum.plus(line.lineTotal), Money.fromAmount(0n, currency))
  if (net.plus(terms.freight).isLessThan(terms.discount))
    return left(new InvalidInputError('/discount', 'a discount cannot exceed what is charged'))
  if (net.isZero())
    return left(new InvalidInputError('/lines', 'an offer worth nothing is not an offer'))
  return right(undefined)
}
