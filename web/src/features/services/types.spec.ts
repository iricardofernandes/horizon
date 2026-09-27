import { describe, expect, it } from 'vitest'
import {
  billableNow,
  type ContractRevision,
  customerServices,
  deliveredShare,
  futureStarts,
  nextBillable,
  nfseHref,
  nfseState,
  periodAmount,
  periodEnd,
  receivableHref,
  receivableState,
  recentCompetences,
  remainingOf,
  revisionInForce,
  type SchedulePeriod,
  totalsOf,
} from './types'

const period = (competence: string, overrides: Partial<SchedulePeriod> = {}): SchedulePeriod => ({
  index: 0,
  startsOn: `${competence}-01`,
  endsOn: `${competence}-28`,
  competence,
  billingOn: `${competence}-05`,
  revision: 1,
  amount: '90000',
  billable: true,
  excluded: null,
  billedPeriodId: null,
  credited: false,
  ...overrides,
})

const revision = (
  number: number,
  effectiveFrom: string,
  lines: ContractRevision['lines'] = [],
): ContractRevision => ({
  number,
  kind: number === 1 ? 'initial' : 'amendment',
  effectiveFrom,
  recurrence: 'monthly',
  readjustmentBasisPoints: null,
  reason: null,
  createdBy: 'ana',
  createdAt: '2026-09-01T00:00:00Z',
  lines,
})

describe('service orders', () => {
  it('says what each line still owes and how much of the order was delivered', () => {
    expect(remainingOf({ quantity: '3', delivered: '1' })).toBe('2')
    expect(remainingOf({ quantity: '1.5', delivered: '2' })).toBe('0')
    const line = { lineId: 'a', itemId: 'b', description: 'x', unitPrice: '1', lineTotal: '1' }
    expect(
      deliveredShare([
        { ...line, quantity: '3', delivered: '1' },
        { ...line, quantity: '1', delivered: '1' },
      ]),
    ).toBe(50)
    expect(deliveredShare([])).toBe(0)
  })
})

describe('contracts', () => {
  it('finds the revision in force and what it bills per period', () => {
    const revisions = [
      revision(1, '2026-08-01', [
        { lineId: 'a', itemId: 'b', description: 'x', quantity: '2', unitPrice: '45000' },
      ]),
      revision(2, '2026-10-01'),
    ]
    expect(revisionInForce(revisions, '2026-09-20')?.number).toBe(1)
    expect(revisionInForce(revisions, '2026-10-01')?.number).toBe(2)
    expect(revisionInForce(revisions, '2026-07-31')).toBeNull()
    expect(periodAmount(revisions[0] as ContractRevision)).toBe('90000')
  })

  it('knows which periods are next, billable now, and open to a change', () => {
    const periods = [
      period('2026-08', { billedPeriodId: 'p1' }),
      period('2026-09'),
      period('2026-10', { billable: false, excluded: 'suspended' }),
      period('2026-11'),
    ]
    expect(nextBillable(periods)?.competence).toBe('2026-09')
    expect(billableNow(periods, '2026-09-20').map((row) => row.competence)).toEqual(['2026-09'])
    expect(billableNow(periods, '2026-09-04')).toEqual([])
    expect(futureStarts(periods, '2026-09-20')).toEqual(['2026-10-01', '2026-11-01'])
  })

  it('lists the months a person may run, and the last day of a period', () => {
    expect(recentCompetences('2026-01-15', 3)).toEqual(['2026-01', '2025-12', '2025-11'])
    expect(periodEnd('2026-10-01', 12)).toBe('2027-09-30')
    expect(periodEnd('2026-12-01', 3)).toBe('2027-02-28')
  })
})

describe('effects', () => {
  it('links a posted receivable to its title and a draft to its reference', () => {
    expect(receivableHref({ titleId: 't1', postedAt: 'x', reversedAt: null }, 'CT-1')).toBe(
      '/app/finance/receivables?open=t1',
    )
    expect(receivableHref(undefined, 'SV-ABCD1234')).toBe(
      '/app/finance/receivables?search=SV-ABCD1234',
    )
    expect(receivableState(undefined)).toBe('draft')
    expect(receivableState(undefined, true)).toBe('withdrawn')
    expect(receivableState({ titleId: 't', postedAt: 'x', reversedAt: 'y' })).toBe('reversed')
  })

  it('links an NFS-e Fiscal reported, and waits for one it has not', () => {
    expect(nfseHref({ documentId: 'd1', status: 'authorized' })).toBe(
      '/app/fiscal/documents?open=d1',
    )
    expect(nfseHref({ documentId: null, status: null })).toBeNull()
    expect(nfseState(undefined)).toBe('awaiting-nfse')
    expect(nfseState({ documentId: 'd', status: 'cancelled' })).toBe('cancelled')
  })
})

describe('customers and runs', () => {
  it("keeps one customer's documents, newest first", () => {
    const base = { customerId: 'c1' }
    const found = customerServices(
      'c1',
      [
        { ...base, id: 'o1', createdAt: '2026-09-01' },
        { ...base, id: 'o2', createdAt: '2026-09-10' },
        { id: 'o3', customerId: 'c2', createdAt: '2026-09-11' },
      ] as never,
      [{ ...base, id: 'k1', createdAt: '2026-08-01' }] as never,
    )
    expect(found.orders.map((order) => order.id)).toEqual(['o2', 'o1'])
    expect(found.contracts.map((contract) => contract.id)).toEqual(['k1'])
  })

  it('counts outcomes', () => {
    expect(
      totalsOf([{ outcome: 'billed' }, { outcome: 'refused' }, { outcome: 'billed' }]),
    ).toEqual({ pending: 0, billed: 2, skipped: 0, refused: 1 })
  })
})
