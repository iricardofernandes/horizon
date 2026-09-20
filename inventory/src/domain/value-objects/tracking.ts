import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

/**
 * Whether the warehouse has to know *which* of a thing it is holding.
 *
 * Most items need no such answer: one screw is every other screw, and asking a picker to
 * name the box would be a cost with nothing on the other side of it. For the items where
 * it matters — a batch that can be recalled, a jar that goes off — it matters completely,
 * which is why this is a decision taken per item rather than a column every item carries.
 *
 * `serial` is deliberately absent. Naming every single unit is a different shape of
 * answer, not a stricter version of this one, and offering it here before the module can
 * honour it would be a workspace turning on a control that does nothing.
 */
export const TRACKING_KINDS = ['none', 'lot'] as const
export type TrackingKind = (typeof TRACKING_KINDS)[number]

/**
 * Whether a lot has to say when it goes off.
 *
 * `required` is the useful one and `optional` is for a warehouse in the middle of
 * adopting the practice: some of what is on the shelf was received before anybody was
 * asked for a date, and refusing to let those lots be picked would stop the warehouse
 * working to enforce a rule about paperwork.
 */
export const EXPIRY_RULES = ['none', 'optional', 'required'] as const
export type ExpiryRule = (typeof EXPIRY_RULES)[number]

export interface ItemTracking {
  readonly kind: TrackingKind
  readonly expiry: ExpiryRule
}

/** What an item with no decision recorded against it gets: counted, not identified. */
export const UNTRACKED: ItemTracking = Object.freeze({ kind: 'none', expiry: 'none' })

export function trackingOf(kind: string, expiry: string): Either<InvalidInputError, ItemTracking> {
  if (!(TRACKING_KINDS as readonly string[]).includes(kind))
    return left(new InvalidInputError('/tracking', `must be one of ${TRACKING_KINDS.join(', ')}`))
  if (!(EXPIRY_RULES as readonly string[]).includes(expiry))
    return left(new InvalidInputError('/expiry', `must be one of ${EXPIRY_RULES.join(', ')}`))
  if (kind === 'none' && expiry !== 'none')
    return left(
      new InvalidInputError('/expiry', 'an item that is not tracked by lot has no expiry rule'),
    )
  return right({ kind: kind as TrackingKind, expiry: expiry as ExpiryRule })
}

/**
 * The code printed on the box.
 *
 * Upper-cased, because it is read off a carton by a person and case is not something a
 * person transcribes reliably; two pickers typing `AB-1204` and `ab-1204` mean the same
 * pallet, and a system that made them two lots would have invented a discrepancy out of
 * nothing but handwriting.
 */
export class LotCode extends ValueObject<{ value: string }> {
  static create(value: string, field = '/lot'): Either<InvalidInputError, LotCode> {
    const normalized = value.trim().replace(/\s+/g, ' ').toUpperCase()
    if (normalized.length < 1 || normalized.length > 60)
      return left(new InvalidInputError(field, 'must contain between 1 and 60 characters'))
    return right(new LotCode({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  override toString(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.props.value]
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The day a lot stops being fit to send anybody.
 *
 * A calendar day rather than an instant, because that is what is printed on the box, and
 * a lot is treated as good for the whole of the day it names: nobody throws out the milk
 * at nine in the morning on the date stamped on the carton.
 */
export class ExpiryDate extends ValueObject<{ value: string }> {
  static create(value: string, field = '/expiresOn'): Either<InvalidInputError, ExpiryDate> {
    if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
      return left(new InvalidInputError(field, 'must be a calendar date as YYYY-MM-DD'))
    // Round-tripping catches the dates that parse but do not exist, such as 2026-02-30.
    if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
      return left(new InvalidInputError(field, 'must be a calendar date that exists'))
    return right(new ExpiryDate({ value }))
  }
  get value(): string {
    return this.props.value
  }
  /** Expired once the day it names is behind us, never during it. */
  hasPassed(now: Date): boolean {
    return this.props.value < now.toISOString().slice(0, 10)
  }
  isBefore(other: ExpiryDate): boolean {
    return this.props.value < other.props.value
  }
  override toString(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.props.value]
  }
}
