import { z } from 'zod'

import { instantSchema, moneySchema, quantitySchema, uuidSchema } from '../common'
import { defineEvent } from './define'

const placedLineSchema = z.object({
  lineId: uuidSchema,
  itemId: uuidSchema,
  quantity: quantitySchema,
})

const confirmedLineSchema = placedLineSchema.extend({
  description: z.string().min(1).max(160),
  unitPrice: moneySchema,
  lineTotal: moneySchema,
})

export const salesOrderPlaced = defineEvent({
  type: 'sales.order.placed',
  version: 1,
  description:
    'A sales order was submitted for atomic stock reservation at its fulfillment warehouse.',
  payload: z.object({
    orderId: uuidSchema,
    orderVersion: z.number().int().positive(),
    customerId: uuidSchema,
    fulfillmentWarehouseId: uuidSchema,
    lines: z.array(placedLineSchema).min(1),
  }),
})

export const salesOrderConfirmed = defineEvent({
  type: 'sales.order.confirmed',
  version: 1,
  description:
    'Inventory reserved every line and Sales committed the immutable commercial snapshot.',
  payload: z.object({
    orderId: uuidSchema,
    orderVersion: z.number().int().positive(),
    customerId: uuidSchema,
    reservationId: uuidSchema,
    confirmedAt: instantSchema,
    lines: z.array(confirmedLineSchema).min(1),
    total: moneySchema,
  }),
})

export const salesOrderCancelled = defineEvent({
  type: 'sales.order.cancelled',
  version: 1,
  description:
    'A sales order will not proceed; Inventory may release its reservation when one exists.',
  payload: z.object({
    orderId: uuidSchema,
    orderVersion: z.number().int().positive(),
    reservationId: uuidSchema.nullable(),
    cancelledAt: instantSchema,
    reason: z.string().trim().min(1).max(500).nullable(),
  }),
})

export const salesInvoicingRequested = defineEvent({
  type: 'sales.invoicing.requested',
  version: 1,
  description:
    'A confirmed order is ready for the future Fiscal module to issue its invoice document.',
  payload: z.object({
    orderId: uuidSchema,
    orderVersion: z.number().int().positive(),
    customerId: uuidSchema,
    confirmedAt: instantSchema,
    lines: z.array(confirmedLineSchema).min(1),
    total: moneySchema,
  }),
})
