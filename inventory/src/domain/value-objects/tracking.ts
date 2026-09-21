import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

/**
 * Whether the warehouse has to know *which* of a thing it is holding.
 *
 * Most items need no such answer: one screw is every other screw, and asking a picker to
 * name the box would be a cost with nothing on the other side of it. For the items where
 * it matters — a batch that can be recalled, a jar that goes off, a machine somebody will
 * one day ring up about — it matters completely, which is why this is a decision taken
 * per item rather than a column every item carries.
 *
 * `lot` and `serial` are two different shapes of answer rather than two strengths of the
 * same one. A lot is a quantity of goods that arrived together and are alike; a serial is
 * one unit that is not interchangeable with any other and has a life of its own, from the
 * day it arrived to the day it was scrapped. An item is tracked one way or the other,
 * never both: a serial already says everything a lot would.
 */
export const TRACKING_KINDS = ['none', 'lot', 'serial'] as const
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
  // A date belongs to a batch, not to a unit. What goes off is a jar of something, and
  // the answer for a machine that needs servicing on a date is a service record, not an
  // expiry that would quietly make the machine unsellable.
  if (kind !== 'lot' && expiry !== 'none')
    return left(new InvalidInputError('/expiry', 'only an item tracked by lot has an expiry rule'))
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

/**
 * The name of one unit, which belongs to it for good.
 *
 * Unique for an item across the whole workspace and across all time, including after the
 * unit has been sold: the machine a customer sends back in a year is the same machine,
 * and a warehouse that gave its name away to something else in the meantime has lost the
 * only thread it had. Upper-cased for the same reason a lot code is — it is read off a
 * plate by a person.
 */
export class SerialNumber extends ValueObject<{ value: string }> {
  static create(value: string, field = '/serial'): Either<InvalidInputError, SerialNumber> {
    const normalized = value.trim().replace(/\s+/g, ' ').toUpperCase()
    if (normalized.length < 1 || normalized.length > 80)
      return left(new InvalidInputError(field, 'must contain between 1 and 80 characters'))
    return right(new SerialNumber({ value: normalized }))
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

/**
 * Where a unit is in its life.
 *
 * `returned` is a unit sent back to the supplier it came from, which is not the same as
 * `scrapped`: one is somebody else's problem now and the other is a loss. Both are out of
 * stock, and neither can be picked again.
 */
export const SERIAL_STATUSES = ['in-stock', 'shipped', 'returned', 'scrapped'] as const
export type SerialStatus = (typeof SERIAL_STATUSES)[number]
