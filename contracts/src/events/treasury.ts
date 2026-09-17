import { z } from 'zod'

import { dateSchema, instantSchema, moneySchema, uuidSchema } from '../common'
import { defineEvent } from './define'

export const ACCOUNT_KINDS = ['bank', 'cash', 'card-clearing', 'virtual'] as const
export const ENTRY_DIRECTIONS = ['inflow', 'outflow'] as const
export const ENTRY_SOURCES = ['opening', 'manual', 'transfer', 'transfer-fee', 'reversal'] as const

const accountId = uuidSchema.describe('Treasury account identifier')
const transferId = uuidSchema.describe('Internal transfer identifier')

export const treasuryAccountOpened = defineEvent({
  type: 'treasury.account.opened',
  version: 1,
  description:
    'A bank, cash, card-clearing or virtual account started keeping a journal. Its opening balance arrives as the first `treasury.entry.recorded`.',
  payload: z.object({
    accountId,
    kind: z.enum(ACCOUNT_KINDS),
    name: z.string().min(2).max(120),
    currency: z.string().regex(/^[A-Z]{3}$/),
    openedOn: dateSchema,
  }),
})

export const treasuryEntryRecorded = defineEvent({
  type: 'treasury.entry.recorded',
  version: 1,
  description:
    'One line was appended to an account journal. Amounts are never negative: `direction` says whether money came in or went out. A correction is a new entry naming the one it `reverses`; nothing is edited or deleted (ADR 0042).',
  payload: z.object({
    entryId: uuidSchema,
    accountId,
    direction: z.enum(ENTRY_DIRECTIONS),
    amount: moneySchema,
    valueOn: dateSchema,
    source: z.object({ type: z.enum(ENTRY_SOURCES), id: uuidSchema.nullable() }),
    reverses: uuidSchema.nullable(),
    recordedAt: instantSchema,
  }),
})

export const treasuryTransferPosted = defineEvent({
  type: 'treasury.transfer.posted',
  version: 1,
  description:
    'Money moved between two accounts of the same workspace and currency. Both legs, and the fee when there is one, were committed in the same transaction as this event.',
  payload: z.object({
    transferId,
    fromAccountId: accountId,
    toAccountId: accountId,
    amount: moneySchema,
    fee: moneySchema.nullable(),
    valueOn: dateSchema,
    postedAt: instantSchema,
  }),
})

export const treasuryTransferCancelled = defineEvent({
  type: 'treasury.transfer.cancelled',
  version: 1,
  description:
    'A posted transfer was undone by inverse entries on both accounts. The original legs stay in the journal.',
  payload: z.object({
    transferId,
    cancelledAt: instantSchema,
    reason: z.string().trim().min(3).max(500),
  }),
})
