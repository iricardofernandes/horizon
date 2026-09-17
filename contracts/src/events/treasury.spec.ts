import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  treasuryAccountOpened,
  treasuryEntryRecorded,
  treasuryReconciliationConfirmed,
  treasuryStatementImported,
  treasuryTransferCancelled,
  treasuryTransferPosted,
} from './treasury'

const brl = (amount: string) => ({ amount, currency: 'BRL' })

describe('treasury event contracts', () => {
  it('opens an account of a known kind', () => {
    const opened = {
      accountId: randomUUID(),
      kind: 'bank',
      name: 'Banco do Brasil 1234-5',
      currency: 'BRL',
      openedOn: '2026-09-01',
    }
    expect(treasuryAccountOpened.payload.safeParse(opened).success).toBe(true)
    expect(treasuryAccountOpened.payload.safeParse({ ...opened, kind: 'crypto' }).success).toBe(
      false,
    )
  })

  it('records a journal line with a direction instead of a sign', () => {
    const entry = {
      entryId: randomUUID(),
      accountId: randomUUID(),
      direction: 'outflow',
      amount: brl('1500'),
      valueOn: '2026-09-10',
      source: { type: 'transfer', id: randomUUID() },
      reverses: null,
      recordedAt: '2026-09-10T12:00:00.000Z',
    }
    expect(treasuryEntryRecorded.payload.safeParse(entry).success).toBe(true)
    expect(treasuryEntryRecorded.payload.safeParse({ ...entry, direction: 'debit' }).success).toBe(
      false,
    )
  })

  it('posts and cancels a transfer', () => {
    const transferId = randomUUID()
    expect(
      treasuryTransferPosted.payload.safeParse({
        transferId,
        fromAccountId: randomUUID(),
        toAccountId: randomUUID(),
        amount: brl('10000'),
        fee: brl('350'),
        valueOn: '2026-09-10',
        postedAt: '2026-09-10T12:00:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      treasuryTransferCancelled.payload.safeParse({
        transferId,
        cancelledAt: '2026-09-11T12:00:00.000Z',
        reason: 'Wrong destination',
      }).success,
    ).toBe(true)
  })

  it('imports a statement and confirms a reconciliation with at least one bank line', () => {
    expect(
      treasuryStatementImported.payload.safeParse({
        importId: randomUUID(),
        accountId: randomUUID(),
        format: 'ofx',
        lineCount: 12,
        duplicateCount: 3,
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        importedAt: '2026-09-30T12:00:00.000Z',
      }).success,
    ).toBe(true)
    const confirmed = {
      reconciliationId: randomUUID(),
      accountId: randomUUID(),
      kind: 'match',
      origin: 'suggestion',
      statementLineIds: [randomUUID()],
      entryIds: [randomUUID(), randomUUID()],
      amount: brl('1500'),
      confirmedAt: '2026-09-30T12:00:00.000Z',
    }
    expect(treasuryReconciliationConfirmed.payload.safeParse(confirmed).success).toBe(true)
    expect(
      treasuryReconciliationConfirmed.payload.safeParse({ ...confirmed, statementLineIds: [] })
        .success,
    ).toBe(false)
  })
})
