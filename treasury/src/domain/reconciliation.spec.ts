import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { type OpenItem, Reconciliation } from './entities/reconciliation'
import { fingerprintsOf } from './entities/statement-line'
import {
  type CandidateEntry,
  type CandidateLine,
  suggestMatches,
} from './services/match-suggestions'
import { Reason } from './value-objects/treasury-values'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-20T12:00:00Z')
const item = (
  id: string,
  amount: bigint,
  available = amount < 0n ? -amount : amount,
): OpenItem => ({
  id,
  accountId: 'acc',
  date: '2026-09-15',
  amount,
  available,
})
const base = {
  tenantId: 't',
  accountId: 'acc',
  currency: 'BRL',
  suggestion: null,
  actor: 'u1',
  now,
}

describe('statement fingerprints', () => {
  it('are stable across imports and tell identical lines within a file apart', () => {
    const line = {
      postedOn: '2026-09-15',
      amount: -1000n,
      bankReference: null,
      description: 'Tarifa',
    }
    const first = fingerprintsOf('acc', [line, line, { ...line, bankReference: 'FIT1' }])
    expect(new Set(first).size).toBe(3)
    expect(fingerprintsOf('acc', [line, line, { ...line, bankReference: 'FIT1' }])).toEqual(first)
    expect(fingerprintsOf('other', [line])[0]).not.toBe(first[0])
    expect(fingerprintsOf('acc', [{ ...line, description: '  TARIFÁ ' }])[0]).toBe(first[0])
  })
})

describe('a reconciliation', () => {
  it('matches one bank line to two entries, and only when the amounts balance', () => {
    const line = item('l1', -3000n)
    const entries = [item('e1', -1000n), item('e2', -2000n)]
    const match = valid(
      Reconciliation.match({
        ...base,
        statementLines: [{ item: line }],
        entries: entries.map((entry) => ({ item: entry })),
      }),
    )
    expect(snapshotOf(match).items.map((row) => row.applied)).toEqual(['-3000', '-1000', '-2000'])
    expect(
      Reconciliation.match({
        ...base,
        statementLines: [{ item: line }],
        entries: [{ item: entries[0] as OpenItem }],
      }).isLeft(),
    ).toBe(true)
  })

  it('applies part of a line, refusing more than is unreconciled or another account', () => {
    const line = item('l1', 5000n)
    valid(
      Reconciliation.match({
        ...base,
        statementLines: [{ item: line, amount: 2000n }],
        entries: [{ item: item('e1', 2000n) }],
      }),
    )
    expect(
      Reconciliation.match({
        ...base,
        statementLines: [{ item: item('l2', 5000n, 1000n), amount: 2000n }],
        entries: [{ item: item('e2', 2000n) }],
      }).isLeft(),
    ).toBe(true)
    expect(
      Reconciliation.match({
        ...base,
        statementLines: [{ item: { ...line, accountId: 'other' } }],
        entries: [{ item: item('e3', 5000n) }],
      }).isLeft(),
    ).toBe(true)
  })

  it('records whether a suggestion was accepted as proposed or corrected, and undoes once', () => {
    const suggestion = { key: 'k', score: 80, statementLineIds: ['l1'], entryIds: ['e1'] }
    const accepted = valid(
      Reconciliation.match({
        ...base,
        suggestion,
        statementLines: [{ item: item('l1', 100n) }],
        entries: [{ item: item('e1', 100n) }],
      }),
    )
    expect(snapshotOf(accepted)).toMatchObject({ origin: 'suggestion', corrected: false })
    const corrected = valid(
      Reconciliation.match({
        ...base,
        suggestion,
        statementLines: [{ item: item('l1', 100n) }],
        entries: [{ item: item('e9', 100n) }],
      }),
    )
    expect(snapshotOf(corrected).corrected).toBe(true)
    const reason = valid(Reason.create('Matched the wrong payment'))
    valid(accepted.undo(reason, 'u2', now))
    expect(accepted.undo(reason, 'u2', now).isLeft()).toBe(true)
    expect(accepted.pullDomainEvents().map((event) => event.eventType)).toEqual([
      'treasury.reconciliation.confirmed',
      'treasury.reconciliation.undone',
    ])
  })
})

const line = (
  id: string,
  open: bigint,
  date = '2026-09-15',
  extra: Partial<CandidateLine> = {},
): CandidateLine => ({
  id,
  date,
  open,
  description: '',
  counterparty: null,
  documentId: null,
  ...extra,
})
const entry = (
  id: string,
  open: bigint,
  date = '2026-09-15',
  extra: Partial<CandidateEntry> = {},
): CandidateEntry => ({
  id,
  date,
  open,
  memo: null,
  counterparty: null,
  ...extra,
})

describe('match suggestions', () => {
  it('prefers the entry with the same amount, the closest date and the matching document', () => {
    const [best] = suggestMatches(
      [
        line('l1', -12_345n, '2026-09-15', {
          description: 'PAGTO BOLETO 4471 PAPELARIA CENTRAL',
          documentId: '0004471',
          counterparty: 'PAPELARIA CENTRAL',
        }),
      ],
      [
        entry('e-far', -12_345n, '2026-09-19'),
        entry('e-near', -12_345n, '2026-09-14', {
          memo: 'boleto 4471',
          counterparty: 'Papelaria Central',
        }),
      ],
    )
    expect(best).toMatchObject({ shape: '1:1', entryIds: ['e-near'] })
    expect(best?.reasons.map((reason) => reason.code)).toEqual([
      'amount-exact',
      'date',
      'document',
      'counterparty',
      'text',
    ])
    expect(best?.score).toBeGreaterThan(80)
  })

  it('proposes one line for several entries and several lines for one entry', () => {
    const suggestions = suggestMatches(
      [line('l-batch', -3000n), line('l-a', 700n), line('l-b', 300n)],
      [entry('e1', -1000n), entry('e2', -2000n), entry('e-deposit', 1000n, '2026-09-16')],
    )
    expect(
      suggestions.map((suggestion) => [
        suggestion.shape,
        suggestion.statementLineIds,
        suggestion.entryIds,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['1:N', ['l-batch'], ['e1', 'e2']],
        ['N:1', ['l-a', 'l-b'], ['e-deposit']],
      ]),
    )
  })

  it('is deterministic, never reuses an item, and leaves out dismissed or distant candidates', () => {
    const lines = [line('l1', 500n), line('l2', 500n)]
    const entries = [entry('e1', 500n), entry('e2', 500n), entry('e-late', 500n, '2026-09-30')]
    const first = suggestMatches(lines, entries)
    expect(suggestMatches([...lines].reverse(), [...entries].reverse())).toEqual(first)
    const ids = first.flatMap((suggestion) => [
      ...suggestion.statementLineIds,
      ...suggestion.entryIds,
    ])
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain('e-late')
    const dismissed = new Set(first.map((suggestion) => suggestion.key))
    expect(
      suggestMatches(lines, entries, dismissed).map((suggestion) => suggestion.key),
    ).not.toEqual(first.map((suggestion) => suggestion.key))
  })
})
