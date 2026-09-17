import { z } from 'zod'

import { dateSchema, instantSchema, moneySchema, uuidSchema } from '../common'
import { defineEvent } from './define'

/**
 * The five kinds of account double-entry bookkeeping recognises. The kind fixes the
 * normal balance — assets and expenses are debit accounts, the other three are credit
 * accounts — so nothing has to carry that separately and the two can never disagree.
 */
export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const
export const ENTRY_SIDES = ['debit', 'credit'] as const

/** Where a transaction came from. Postings raised by other modules arrive in Phase F's next slice. */
export const TRANSACTION_SOURCES = ['manual'] as const

/** A calendar month, `YYYY-MM`: the unit a ledger opens and closes. */
export const periodSchema = z
  .string()
  .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, 'must be a calendar month as YYYY-MM')

const accountId = uuidSchema.describe('Ledger account identifier')
const accountCode = z
  .string()
  .regex(/^\d{1,3}(?:\.\d{1,3}){0,4}$/, 'must be a dotted numeric code, e.g. 1.01.001')

export const ledgerAccountOpened = defineEvent({
  type: 'ledger.account.opened',
  version: 1,
  description:
    'An account was added to the chart of accounts. Only a leaf account is `postable`; a parent exists to total its children and never takes a line of its own.',
  payload: z.object({
    accountId,
    code: accountCode,
    name: z.string().min(2).max(120),
    type: z.enum(ACCOUNT_TYPES),
    parentId: accountId.nullable(),
    postable: z.boolean(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    openedAt: instantSchema,
  }),
})

export const ledgerTransactionPosted = defineEvent({
  type: 'ledger.transaction.posted',
  version: 1,
  description:
    'A balanced journal transaction was posted. Its debits equal its credits, every line is in the transaction currency, and `postedOn` falls in an open period. A posted transaction is never edited: a correction is a reversal plus a new transaction (ADR 0042).',
  payload: z.object({
    transactionId: uuidSchema,
    reference: z.string().min(1).max(60),
    postedOn: dateSchema,
    period: periodSchema,
    /** The sum of the debit lines, which is also the sum of the credit lines. */
    total: moneySchema,
    source: z.object({ type: z.enum(TRANSACTION_SOURCES), id: uuidSchema.nullable() }),
    lines: z
      .array(
        z.object({
          lineNumber: z.number().int().positive(),
          accountId,
          accountCode,
          side: z.enum(ENTRY_SIDES),
          amount: moneySchema,
          memo: z.string().max(200).nullable(),
        }),
      )
      .min(2),
    postedAt: instantSchema,
  }),
})

export const ledgerTransactionReversed = defineEvent({
  type: 'ledger.transaction.reversed',
  version: 1,
  description:
    'A posted transaction was undone by a mirror transaction with every side swapped. Both stay in the journal, and the reversal cannot itself be reversed.',
  payload: z.object({
    transactionId: uuidSchema,
    reversalId: uuidSchema,
    reversedAt: instantSchema,
    reason: z.string().trim().min(3).max(500),
  }),
})

export const ledgerPeriodClosed = defineEvent({
  type: 'ledger.period.closed',
  version: 1,
  description:
    'A calendar month was closed. Nothing may be posted into it, or reversed inside it, until it is reopened with a reason.',
  payload: z.object({
    periodId: uuidSchema,
    period: periodSchema,
    closedAt: instantSchema,
  }),
})

export const ledgerPeriodReopened = defineEvent({
  type: 'ledger.period.reopened',
  version: 1,
  description:
    'A closed month was reopened so it can take postings again. The reason is kept, because reopening a closed period is an accounting event in its own right.',
  payload: z.object({
    periodId: uuidSchema,
    period: periodSchema,
    reopenedAt: instantSchema,
    reason: z.string().trim().min(3).max(500),
  }),
})
