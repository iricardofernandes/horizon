import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { Quantity } from '../value-objects/inventory-values'
import type { ExpiryDate, ExpiryRule, LotCode } from '../value-objects/tracking'

/** Goods arriving under a code, with the day they go off if anybody said. */
export interface LotEntry {
  readonly code: LotCode
  readonly expiresOn: ExpiryDate | null
  readonly quantity: Quantity
}

/** Goods leaving a named lot. Which lot, and how much of it. */
export interface LotPick {
  readonly code: LotCode
  readonly quantity: Quantity
}

export interface LotHolding {
  readonly code: LotCode
  readonly expiresOn: ExpiryDate | null
  readonly onHand: Quantity
  /** When this code was first seen here, which is how equal expiry dates are settled. */
  readonly firstReceivedAt: Date
}

/**
 * Which boxes a shelf is holding, and which ones go next.
 *
 * The book belongs to one balance and is kept in step with it: what it totals is what the
 * balance has on hand, always, which is the invariant that makes a lot-tracked warehouse
 * worth having at all. A warehouse whose lots add up to something other than its balance
 * cannot answer either question honestly, so it is refused rather than reconciled.
 *
 * Reservations are deliberately absent. A promise made to a customer is for goods, not for
 * a particular box: pinning a lot weeks before a van arrives would hold back the very
 * stock that ought to go first, and would have to be repinned every time something with
 * an earlier date was delivered. Which boxes go is decided when somebody walks to the
 * shelf.
 */
export class LotBook {
  private readonly holdings: LotHolding[]

  constructor(holdings: readonly LotHolding[] = []) {
    this.holdings = [...holdings]
  }

  lots(): readonly LotHolding[] {
    return [...this.holdings].sort(byPickingOrder)
  }

  isEmpty(): boolean {
    return this.holdings.length === 0
  }

  total(): Quantity {
    return this.holdings.reduce((sum, lot) => sum.plus(lot.onHand), Quantity.fromMicros(0n))
  }

  /** What is still fit to send somebody: everything whose date has not gone by. */
  sellable(now: Date): Quantity {
    return this.holdings
      .filter((lot) => !isExpired(lot, now))
      .reduce((sum, lot) => sum.plus(lot.onHand), Quantity.fromMicros(0n))
  }

  /**
   * Goods arrive under the codes the caller named.
   *
   * A code already on the shelf is the same lot arriving again, so its date is not open
   * to being restated: two cartons stamped differently are two lots, and letting the
   * second one overwrite the first would quietly move the expiry of stock already here.
   */
  put(
    entries: readonly LotEntry[],
    expiry: ExpiryRule,
    now: Date,
  ): Either<ConflictError, readonly LotEntry[]> {
    for (const entry of entries) {
      if (entry.quantity.isZero())
        return left(new ConflictError('a lot cannot be received in a quantity of nothing'))
      const held = this.find(entry.code)
      if (!held && expiry === 'required' && !entry.expiresOn)
        return left(new ConflictError(`lot ${entry.code} must say when it expires`))
      if (held && !sameDate(held.expiresOn, entry.expiresOn) && entry.expiresOn)
        return left(
          new ConflictError(`lot ${entry.code} is already here with a different expiry date`),
        )
      if (held) this.replace({ ...held, onHand: held.onHand.plus(entry.quantity) })
      else
        this.holdings.push({
          code: entry.code,
          expiresOn: entry.expiresOn,
          onHand: entry.quantity,
          firstReceivedAt: now,
        })
    }
    return right(entries)
  }

  /**
   * Goods leave, from the lots named or from the ones that should go first.
   *
   * Left to itself the book sends the earliest date first and keeps what has no date for
   * last, settling ties by which arrived first. A lot whose day has gone by is never
   * chosen this way — it has to be named, by somebody who has decided what they are doing
   * with it — and `allowExpired` is what says whether that decision is one this movement
   * is entitled to make.
   */
  take(
    quantity: Quantity,
    picks: readonly LotPick[] | null,
    now: Date,
    allowExpired: boolean,
  ): Either<ConflictError, readonly LotEntry[]> {
    const chosen = picks ? this.named(picks, now, allowExpired) : this.fefo(quantity, now)
    if (chosen.isLeft()) return left(chosen.value)
    const total = chosen.value.reduce(
      (sum, pick) => sum.plus(pick.quantity),
      Quantity.fromMicros(0n),
    )
    if (total.micros !== quantity.micros)
      return left(new ConflictError('the lots named do not add up to the quantity moved'))
    for (const pick of chosen.value) {
      const held = this.find(pick.code)
      if (!held) return left(new ConflictError(`lot ${pick.code} is not on this shelf`))
      this.replace({ ...held, onHand: held.onHand.minus(pick.quantity) })
    }
    this.forget()
    return right(chosen.value)
  }

  private named(
    picks: readonly LotPick[],
    now: Date,
    allowExpired: boolean,
  ): Either<ConflictError, readonly LotEntry[]> {
    const drawn: LotEntry[] = []
    const seen = new Set<string>()
    for (const pick of picks) {
      if (seen.has(pick.code.value))
        return left(new ConflictError(`lot ${pick.code} was named twice`))
      seen.add(pick.code.value)
      const held = this.find(pick.code)
      if (!held) return left(new ConflictError(`lot ${pick.code} is not on this shelf`))
      if (pick.quantity.isZero())
        return left(new ConflictError('a lot cannot be drawn in a quantity of nothing'))
      if (held.onHand.isLessThan(pick.quantity))
        return left(new ConflictError(`lot ${pick.code} does not hold that much`))
      if (!allowExpired && isExpired(held, now))
        return left(new ConflictError(`lot ${pick.code} has expired and cannot go out this way`))
      drawn.push({ code: held.code, expiresOn: held.expiresOn, quantity: pick.quantity })
    }
    return right(drawn)
  }

  private fefo(quantity: Quantity, now: Date): Either<ConflictError, readonly LotEntry[]> {
    const drawn: LotEntry[] = []
    let outstanding = quantity
    for (const lot of this.holdings.filter((held) => !isExpired(held, now)).sort(byPickingOrder)) {
      if (outstanding.isZero()) break
      const taken = outstanding.isLessThan(lot.onHand) ? outstanding : lot.onHand
      if (taken.isZero()) continue
      drawn.push({ code: lot.code, expiresOn: lot.expiresOn, quantity: taken })
      outstanding = outstanding.minus(taken)
    }
    if (!outstanding.isZero())
      return left(new ConflictError('there is not enough unexpired stock in any lot'))
    return right(drawn)
  }

  private find(code: LotCode): LotHolding | undefined {
    return this.holdings.find((lot) => lot.code.value === code.value)
  }

  private replace(lot: LotHolding): void {
    const index = this.holdings.findIndex((held) => held.code.value === lot.code.value)
    if (index === -1) this.holdings.push(lot)
    else this.holdings[index] = lot
  }

  /** A lot that has run out stops being a holding; its history stays in the movements. */
  private forget(): void {
    for (let index = this.holdings.length - 1; index >= 0; index -= 1)
      if (this.holdings[index]?.onHand.isZero()) this.holdings.splice(index, 1)
  }
}

function isExpired(lot: LotHolding, now: Date): boolean {
  return lot.expiresOn?.hasPassed(now) ?? false
}

/**
 * What a set of lot movements leaves outstanding, per item.
 *
 * Written once and used by both the database and the in-memory fake, because it is the
 * arithmetic a customer return depends on: five sent and two already back leaves three
 * that may still come home, and a second partial return must not be able to put more into
 * a lot than that lot ever sent.
 */
export function outstandingByItem(
  moves: readonly {
    itemId: string
    code: LotCode
    expiresOn: ExpiryDate | null
    quantity: Quantity
    outbound: boolean
  }[],
): ReadonlyMap<string, readonly LotEntry[]> {
  const netted = new Map<string, { itemId: string; entry: LotEntry }>()
  for (const move of moves) {
    const key = `${move.itemId}\u0000${move.code.value}`
    const signed = move.outbound ? move.quantity.micros : -move.quantity.micros
    const held = netted.get(key)
    const total = (held?.entry.quantity.micros ?? 0n) + signed
    netted.set(key, {
      itemId: move.itemId,
      entry: {
        code: move.code,
        expiresOn: move.expiresOn,
        quantity: Quantity.fromMicros(total > 0n ? total : 0n),
      },
    })
  }
  const byItem = new Map<string, LotEntry[]>()
  for (const { itemId, entry } of netted.values()) {
    if (entry.quantity.isZero()) continue
    byItem.set(itemId, [...(byItem.get(itemId) ?? []), entry])
  }
  return byItem
}

function sameDate(left: ExpiryDate | null, right: ExpiryDate | null): boolean {
  if (left === null || right === null) return left === right
  return left.value === right.value
}

/** Earliest date first, no date last, then whichever arrived first, then by code. */
function byPickingOrder(a: LotHolding, b: LotHolding): number {
  if (a.expiresOn && b.expiresOn && a.expiresOn.value !== b.expiresOn.value)
    return a.expiresOn.isBefore(b.expiresOn) ? -1 : 1
  if (a.expiresOn && !b.expiresOn) return -1
  if (!a.expiresOn && b.expiresOn) return 1
  if (a.firstReceivedAt.getTime() !== b.firstReceivedAt.getTime())
    return a.firstReceivedAt.getTime() - b.firstReceivedAt.getTime()
  return a.code.value.localeCompare(b.code.value)
}
