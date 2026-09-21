import type { Quantity } from '../value-objects/inventory-values'
import type { LotCode, SerialNumber } from '../value-objects/tracking'
import type { LotEntry, LotPick } from './lot-book'

/**
 * Which particular goods a movement is about.
 *
 * One shape for both ways of identifying stock, because every command that moves anything
 * has to carry the answer and none of them should care which kind it is: the balance
 * knows how its item is tracked and refuses the wrong sort. Both lists empty is what an
 * item nobody identifies looks like, and is the only thing such an item may say.
 */
export interface Units {
  readonly lots: readonly LotEntry[]
  readonly serials: readonly SerialNumber[]
}

/** The same, on the way out, where a lot needs a quantity and a unit is its own. */
export interface Picks {
  readonly lots: readonly LotPick[]
  readonly serials: readonly SerialNumber[]
}

export const NOTHING_NAMED: Units = Object.freeze({ lots: [], serials: [] })

export const ofLots = (lots: readonly LotEntry[]): Units => ({ lots, serials: [] })
export const ofSerials = (serials: readonly SerialNumber[]): Units => ({ lots: [], serials })
export const pickLots = (lots: readonly LotPick[]): Picks => ({ lots, serials: [] })
export const pickSerials = (serials: readonly SerialNumber[]): Picks => ({ lots: [], serials })

export const namesNothing = (units: Units | Picks | null): boolean =>
  units === null || (units.lots.length === 0 && units.serials.length === 0)

/**
 * One line's worth of "which goods", said both ways round.
 *
 * A write-off and a count difference each know what they are about — a lot, some named
 * units, or nothing — and each has to hand it to the balance as an arrival or a
 * departure. Turning that into the two shapes in one place keeps the two callers from
 * disagreeing about what "nothing named" means.
 */
export function naming(what: {
  lot?: LotCode | null
  serials?: readonly SerialNumber[]
  quantity: Quantity
}): { named: Units | null; picked: Picks | null } {
  if (what.lot)
    return {
      named: ofLots([{ code: what.lot, expiresOn: null, quantity: what.quantity }]),
      picked: pickLots([{ code: what.lot, quantity: what.quantity }]),
    }
  const serials = what.serials ?? []
  if (serials.length > 0) return { named: ofSerials(serials), picked: pickSerials(serials) }
  return { named: null, picked: null }
}
