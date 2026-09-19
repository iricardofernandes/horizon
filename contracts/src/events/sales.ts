import { z } from 'zod'

import { dateSchema, instantSchema, moneySchema, quantitySchema, uuidSchema } from '../common'
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

/** One agreed payment: when it falls due and how much of the total it is for. */
const installmentSchema = z.object({
  number: z.number().int().positive(),
  dueOn: dateSchema,
  amount: moneySchema,
})

const quoteId = uuidSchema.describe('The identifier of this version of the offer')
const quoteRoot = uuidSchema.describe('Shared by every version of one offer')
const quoteVersion = z.number().int().positive()

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
    // Optional so that a consumer written before payment terms existed keeps parsing
    // confirmations, and one written after can raise the receivable on what was agreed
    // rather than on a single instalment it invented (ADR 0030).
    installments: z.array(installmentSchema).min(1).optional(),
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
    // The same schedule the confirmation carries. Either fact can be the first to reach a
    // consumer, so they must not disagree about when the money was agreed to arrive.
    installments: z.array(installmentSchema).min(1).optional(),
  }),
})

export const salesQuoteSent = defineEvent({
  type: 'sales.quote.sent',
  version: 1,
  description:
    'This version of an offer was put in front of the customer, priced and dated. A quote sent is never rewritten: negotiating produces a new version beside it, sharing the same root.',
  payload: z.object({
    quoteId,
    quoteRoot,
    version: quoteVersion,
    customerId: uuidSchema,
    total: moneySchema,
    expiresAt: instantSchema,
  }),
})

export const salesQuoteAccepted = defineEvent({
  type: 'sales.quote.accepted',
  version: 1,
  description:
    'The customer agreed to this version of the offer. Nothing is committed and no stock is held until the quote is converted into an order.',
  payload: z.object({
    quoteId,
    quoteRoot,
    version: quoteVersion,
    customerId: uuidSchema,
    total: moneySchema,
  }),
})

export const salesQuoteRejected = defineEvent({
  type: 'sales.quote.rejected',
  version: 1,
  description:
    'The customer declined this version of the offer, with the reason they gave. A refusal is worth as much to the record as a yes.',
  payload: z.object({
    quoteId,
    quoteRoot,
    version: quoteVersion,
    customerId: uuidSchema,
    reason: z.string().trim().min(1).max(500),
  }),
})
