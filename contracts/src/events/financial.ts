import { z } from 'zod'

import { dateSchema, instantSchema, moneySchema, uuidSchema } from '../common'
import { defineEvent } from './define'

export const TITLE_DIRECTIONS = ['receivable', 'payable'] as const

const titleId = uuidSchema.describe('Financial title identifier')
const reason = z.string().trim().min(3).max(500)

/** Where a title came from. A title raised from a sales order names the order. */
const originSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({ type: z.literal('sales-order'), orderId: uuidSchema }),
])

/** Shared by both directions, so a receivable and a payable carry the same shape. */
const postedPayload = z.object({
  titleId,
  partyId: uuidSchema,
  documentNumber: z.string().min(1).max(40),
  origin: originSchema,
  categoryId: uuidSchema,
  issuedOn: dateSchema,
  competenceOn: dateSchema,
  total: moneySchema,
  installments: z
    .array(
      z.object({ number: z.number().int().positive(), dueOn: dateSchema, amount: moneySchema }),
    )
    .min(1)
    .max(120),
  allocations: z
    .array(z.object({ dimensionId: uuidSchema, basisPoints: z.number().int().min(1).max(10_000) }))
    .max(50),
  postedAt: instantSchema,
})

export const financialReceivablePosted = defineEvent({
  type: 'financial.receivable.posted',
  version: 1,
  description:
    'A receivable left draft and became an immutable claim on a customer. Installment amounts always add up to the total; from here corrections are reversals, never edits (ADR 0042).',
  payload: postedPayload,
})

const reversedPayload = z.object({
  titleId,
  partyId: uuidSchema,
  reversedAt: instantSchema,
  reason,
})

export const financialReceivableReversed = defineEvent({
  type: 'financial.receivable.reversed',
  version: 1,
  description:
    'A posted receivable with no settlement in force was reversed. The title remains, marked reversed, so its history and the reason stay readable.',
  payload: reversedPayload,
})

export const financialPayablePosted = defineEvent({
  type: 'financial.payable.posted',
  version: 1,
  description:
    'A payable left draft and became an obligation to a supplier, after the approval the workspace policy required. Installment amounts always add up to the total; corrections are reversals, never edits (ADR 0042).',
  payload: postedPayload,
})

export const financialPayableReversed = defineEvent({
  type: 'financial.payable.reversed',
  version: 1,
  description:
    'A posted payable with no settlement in force was reversed. The title remains, marked reversed, with its reason.',
  payload: reversedPayload,
})

const settlementId = uuidSchema.describe('Settlement identifier')

export const financialSettlementRecorded = defineEvent({
  type: 'financial.settlement.recorded',
  version: 1,
  description:
    'Money was received or paid against one installment. `received` is the cash that moved; `discount` reduces what is owed without cash; `interest` and `penalty` add to it. `outstanding` is the title balance after this settlement.',
  payload: z.object({
    settlementId,
    titleId,
    direction: z.enum(TITLE_DIRECTIONS),
    partyId: uuidSchema,
    installmentNumber: z.number().int().positive(),
    settledOn: dateSchema,
    received: moneySchema,
    discount: moneySchema,
    interest: moneySchema,
    penalty: moneySchema,
    paymentMethodId: uuidSchema.nullable(),
    outstanding: moneySchema,
    recordedAt: instantSchema,
  }),
})

export const financialSettlementReversed = defineEvent({
  type: 'financial.settlement.reversed',
  version: 1,
  description:
    'A recorded settlement was undone — a bounced payment, a wrong installment. The settlement stays in history, marked reversed; `outstanding` is the title balance restored.',
  payload: z.object({
    settlementId,
    titleId,
    direction: z.enum(TITLE_DIRECTIONS),
    partyId: uuidSchema,
    reversedAt: instantSchema,
    reason,
    outstanding: moneySchema,
  }),
})
