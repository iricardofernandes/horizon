import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { ItemKind } from '../repositories/sales-repositories'

/**
 * A sales order is a goods order (ADR 0056).
 *
 * Its lines are reserved in a warehouse and leave in shipments, and neither means anything
 * for a service: a service is delivered by a service order, stage by stage. Refusing here,
 * before the order is placed, keeps a service from ever reaching Inventory — where it would
 * only be rejected for lack of stock, with no reason a person could act on.
 *
 * An item whose kind is not known yet (projected before Phase 49) is treated as a good,
 * which is what it has always been treated as.
 */
export function goodsOnly(
  lines: readonly { lineId: string; itemId: string }[],
  kinds: ReadonlyMap<string, ItemKind>,
  from: 'order' | 'proposal',
): Either<ConflictError, void> {
  const services = lines.filter((line) => kinds.get(line.itemId) === 'service')
  if (services.length === 0) return right(undefined)
  const named = services.map((line) => line.lineId).join(', ')
  return left(
    new ConflictError(
      from === 'proposal'
        ? `service lines of a proposal are delivered by a service order, not a sales order (lines ${named})`
        : `service items are delivered by a service order, not a sales order (lines ${named})`,
    ),
  )
}
