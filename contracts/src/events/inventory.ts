import { z } from 'zod'

import { instantSchema, moneySchema, quantitySchema, uuidSchema } from '../common'
import { defineEvent } from './define'

const reservationLineSchema = z.object({
  lineId: uuidSchema,
  itemId: uuidSchema,
  warehouseId: uuidSchema,
  quantity: quantitySchema,
})

const shortfallSchema = reservationLineSchema.extend({
  availableQuantity: quantitySchema,
})

export const inventoryStockReserved = defineEvent({
  type: 'inventory.stock.reserved',
  version: 1,
  description:
    'Every line of a placed sales order was held atomically until confirmation or expiry.',
  payload: z.object({
    orderId: uuidSchema,
    orderVersion: z.number().int().positive(),
    reservationId: uuidSchema,
    expiresAt: instantSchema,
    lines: z.array(reservationLineSchema).min(1),
  }),
})

export const inventoryStockReservationRejected = defineEvent({
  type: 'inventory.stock.reservation-rejected',
  version: 1,
  description:
    'A sales order could not be reserved atomically; no line was held and every shortfall is reported.',
  payload: z.object({
    orderId: uuidSchema,
    orderVersion: z.number().int().positive(),
    shortfalls: z.array(shortfallSchema).min(1),
  }),
})

export const inventoryStockReleased = defineEvent({
  type: 'inventory.stock.released',
  version: 1,
  description: 'A reservation stopped holding stock because its order was cancelled or it expired.',
  payload: z.object({
    orderId: uuidSchema,
    orderVersion: z.number().int().positive(),
    reservationId: uuidSchema,
    reason: z.enum(['cancelled', 'expired']),
    releasedAt: instantSchema,
  }),
})

/**
 * Why a movement happened, and under which document.
 *
 * `sale` and `purchase` were once left out: a shipment left because it was sold, and the
 * kind said so. They are named now because a warehouse that tracks which boxes it holds
 * has to be able to answer where a particular box went, and "it was sold" is not an
 * answer without the order that sold it.
 */
export const movementReasonSchema = z.enum([
  'sale',
  'purchase',
  'production',
  'transfer',
  'count',
  'breakage',
  'loss',
  'theft',
  'expiry',
  'found',
  'correction',
])

/**
 * The document a movement belongs to.
 *
 * The two halves of a transfer carry the same one, which is what pairs them: a reader
 * seeing goods leave one warehouse can find where they arrived without the event having
 * to name the other side.
 */
export const movementDocumentSchema = z.object({
  type: z.enum(['order', 'receipt', 'production-order', 'transfer', 'adjustment', 'count']),
  id: uuidSchema,
})

export const inventoryStockMoved = defineEvent({
  type: 'inventory.stock.moved',
  version: 1,
  description:
    'An append-only movement changed on-hand stock and records the resulting balance and cost.',
  payload: z.object({
    movementId: uuidSchema,
    itemId: uuidSchema,
    warehouseId: uuidSchema,
    kind: z.enum([
      'receipt',
      'shipment',
      'adjustment-in',
      'adjustment-out',
      'return-in',
      'transfer-in',
      'transfer-out',
      // Goods consumed by a production order, and the goods it made. Neither is an
      // adjustment: nothing was lost and nobody was billed — material turned into product.
      'production-out',
      'production-in',
    ]),
    balanceVersion: z.number().int().positive(),
    quantity: quantitySchema,
    balanceAfter: quantitySchema,
    unitCost: moneySchema.nullable(),
    // Optional, so a producer written before stock could be transferred, adjusted or
    // counted keeps emitting a movement this schema accepts.
    reason: movementReasonSchema.optional(),
    document: movementDocumentSchema.optional(),
  }),
})
