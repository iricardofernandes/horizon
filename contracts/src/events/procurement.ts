import { z } from 'zod'

import { dateSchema, moneySchema, quantitySchema, uuidSchema } from '../common'
import { defineEvent } from './define'

const requisitionId = uuidSchema.describe('Purchase requisition identifier')
const orderId = uuidSchema.describe('Purchase order identifier')
const documentVersion = z.number().int().positive()

const requestedLineSchema = z.object({
  lineId: uuidSchema,
  itemId: uuidSchema,
  quantity: quantitySchema,
})

/**
 * A line of an order, priced. The description is the buyer's own words as the order was
 * written, not a pointer into the catalogue: an item renamed later must not change what a
 * supplier was asked to deliver.
 */
const orderLineSchema = requestedLineSchema.extend({
  description: z.string().min(1).max(160),
  unitPrice: moneySchema,
  lineTotal: moneySchema,
})

const installmentSchema = z.object({
  number: z.number().int().positive(),
  dueOn: dateSchema,
  amount: moneySchema,
})

/** Everything a consumer needs to act on an order without asking Procurement anything. */
const commercial = {
  supplierId: uuidSchema.describe('The party the goods are being bought from'),
  supplierName: z.string().min(2).max(160),
  requisitionId: requisitionId.nullable(),
  warehouseId: uuidSchema.describe('Where the goods are to be delivered'),
  issuedOn: dateSchema,
  expectedOn: dateSchema,
  total: moneySchema,
  lines: z.array(orderLineSchema).min(1),
}

export const procurementRequisitionSubmitted = defineEvent({
  type: 'procurement.requisition.submitted',
  version: 1,
  description:
    'Somebody asked for something to be bought and sent the request for a decision. A requisition carries no prices: what it asserts is a need, and what it will cost is discovered afterwards by asking suppliers.',
  payload: z.object({
    requisitionId,
    requisitionVersion: documentVersion,
    requestedBy: z.string().min(1).max(255),
    submittedBy: z.string().min(1).max(255),
    warehouseId: uuidSchema,
    neededBy: dateSchema,
    lines: z.array(requestedLineSchema).min(1),
  }),
})

export const procurementRequisitionApproved = defineEvent({
  type: 'procurement.requisition.approved',
  version: 1,
  description:
    'The need was agreed by somebody other than whoever submitted it. Nothing is committed and no supplier has been chosen; the requisition is now open to being answered by an order.',
  payload: z.object({
    requisitionId,
    requisitionVersion: documentVersion,
    approvedBy: z.string().min(1).max(255),
    warehouseId: uuidSchema,
  }),
})

export const procurementRequisitionRejected = defineEvent({
  type: 'procurement.requisition.rejected',
  version: 1,
  description: 'The need was refused, with the reason it was refused for.',
  payload: z.object({
    requisitionId,
    requisitionVersion: documentVersion,
    rejectedBy: z.string().min(1).max(255),
    reason: z.string().min(3).max(300),
  }),
})

export const procurementOrderPlaced = defineEvent({
  type: 'procurement.order.placed',
  version: 1,
  description:
    'A purchase order was submitted. `approvalRequired` says whether the workspace threshold sends it to a second person; when it is false the order is committed in the same operation and `procurement.order.approved` follows immediately.',
  payload: z.object({
    orderId,
    orderVersion: documentVersion,
    placedBy: z.string().min(1).max(255),
    approvalRequired: z.boolean(),
    ...commercial,
  }),
})

export const procurementOrderApproved = defineEvent({
  type: 'procurement.order.approved',
  version: 1,
  description:
    'The company committed to buy. This is the fact a payable forecast is raised from: `installments` is the schedule the agreed payment terms imply, already dated, so no consumer has to know how the terms were expressed.',
  payload: z.object({
    orderId,
    orderVersion: documentVersion,
    approvedBy: z.string().min(1).max(255),
    approvalRequired: z.boolean(),
    installments: z.array(installmentSchema).min(1),
    ...commercial,
  }),
})

export const procurementOrderRejected = defineEvent({
  type: 'procurement.order.rejected',
  version: 1,
  description:
    'An order waiting for approval was refused. Nothing was committed, so nothing has to be undone.',
  payload: z.object({
    orderId,
    orderVersion: documentVersion,
    rejectedBy: z.string().min(1).max(255),
    reason: z.string().min(3).max(300),
  }),
})

export const procurementOrderCancelled = defineEvent({
  type: 'procurement.order.cancelled',
  version: 1,
  description:
    'A purchase order was withdrawn. `wasApproved` tells a consumer whether anything had been committed on the strength of it and therefore has to be withdrawn too.',
  payload: z.object({
    orderId,
    orderVersion: documentVersion,
    reason: z.string().min(3).max(300),
    wasApproved: z.boolean(),
  }),
})
