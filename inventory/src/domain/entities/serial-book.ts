import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { Quantity } from '../value-objects/inventory-values'
import type { SerialNumber } from '../value-objects/tracking'

/** One unit on the shelf, and when it got here. */
export interface SerialHolding {
  readonly serial: SerialNumber
  readonly receivedAt: Date
}

/** A serial is one unit, so a count of them is a quantity with nothing to convert. */
const UNIT = 1_000_000n
export const unitsOf = (count: number) => Quantity.fromMicros(BigInt(count) * UNIT)

/**
 * Which units a shelf is holding, by name.
 *
 * The same invariant as the lot book — what it counts is what the balance has on hand —
 * arrived at differently: a lot is a quantity that happens to have a code, while a serial
 * *is* the unit, so the quantity is never stated separately and can never disagree. A
 * movement of three named units is a movement of three; there is no third figure to get
 * wrong.
 *
 * The book knows only its own shelf. That a serial is in stock in at most one place in
 * the workspace, and that it keeps its name after it has gone, are facts about every
 * shelf at once, so they are kept by the store and by a deferred constraint rather than
 * here.
 */
export class SerialBook {
  private readonly holdings: SerialHolding[]

  constructor(holdings: readonly SerialHolding[] = []) {
    this.holdings = [...holdings]
  }

  serials(): readonly SerialHolding[] {
    return [...this.holdings].sort(byArrival)
  }

  count(): Quantity {
    return unitsOf(this.holdings.length)
  }

  has(serial: SerialNumber): boolean {
    return this.holdings.some((held) => held.serial.value === serial.value)
  }

  /**
   * Units arrive under the names on their plates.
   *
   * A name already on this shelf is refused rather than merged: two units cannot share
   * one, and a warehouse that quietly accepted the second would be holding two things it
   * could only ever tell apart by walking over and looking.
   */
  put(serials: readonly SerialNumber[], now: Date): Either<ConflictError, void> {
    const arriving = new Set<string>()
    for (const serial of serials) {
      if (arriving.has(serial.value))
        return left(new ConflictError(`unit ${serial} was named twice`))
      arriving.add(serial.value)
      if (this.has(serial))
        return left(new ConflictError(`unit ${serial} is already on this shelf`))
    }
    for (const serial of serials) this.holdings.push({ serial, receivedAt: now })
    return right(undefined)
  }

  /**
   * Units leave, the ones named or the ones that have been here longest.
   *
   * Left to itself the book sends what arrived first, which is the only order it has any
   * reason to prefer: one unit is not fresher than another, but the one that has been
   * sitting here since spring is the one somebody should stop paying to store.
   */
  take(
    quantity: Quantity,
    picks: readonly SerialNumber[] | null,
  ): Either<ConflictError, readonly SerialNumber[]> {
    const wanted = quantity.micros
    if (wanted % UNIT !== 0n)
      return left(new ConflictError('a unit with a name is not moved in fractions'))
    const chosen: Either<ConflictError, readonly SerialNumber[]> = picks
      ? this.named(picks)
      : right(this.oldest(Number(wanted / UNIT)))
    if (chosen.isLeft()) return left(chosen.value)
    if (unitsOf(chosen.value.length).micros !== wanted)
      return left(new ConflictError('the units named do not add up to the quantity moved'))
    const leaving = new Set(chosen.value.map((serial) => serial.value))
    for (let index = this.holdings.length - 1; index >= 0; index -= 1)
      if (leaving.has(this.holdings[index]?.serial.value ?? '')) this.holdings.splice(index, 1)
    return right(chosen.value)
  }

  private named(picks: readonly SerialNumber[]): Either<ConflictError, readonly SerialNumber[]> {
    const seen = new Set<string>()
    for (const serial of picks) {
      if (seen.has(serial.value)) return left(new ConflictError(`unit ${serial} was named twice`))
      seen.add(serial.value)
      if (!this.has(serial)) return left(new ConflictError(`unit ${serial} is not on this shelf`))
    }
    return right(picks)
  }

  private oldest(count: number): readonly SerialNumber[] {
    return this.serials()
      .slice(0, count)
      .map((held) => held.serial)
  }
}

/** Longest here goes first; a shelf loaded in one go is settled by name. */
function byArrival(a: SerialHolding, b: SerialHolding): number {
  if (a.receivedAt.getTime() !== b.receivedAt.getTime())
    return a.receivedAt.getTime() - b.receivedAt.getTime()
  return a.serial.value.localeCompare(b.serial.value)
}
