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

export const inventoryStockMoved = defineEvent({
  type: 'inventory.stock.moved',
  version: 1,
  description:
    'An append-only movement changed on-hand stock and records the resulting balance and cost.',
  payload: z.object({
    movementId: uuidSchema,
    itemId: uuidSchema,
    warehouseId: uuidSchema,
    kind: z.enum(['receipt', 'shipment', 'adjustment-in', 'adjustment-out', 'return-in']),
    balanceVersion: z.number().int().positive(),
    quantity: quantitySchema,
    balanceAfter: quantitySchema,
    unitCost: moneySchema.nullable(),
  }),
})
