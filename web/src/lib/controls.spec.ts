import { describe, expect, it } from 'vitest'
import {
  attentionOf,
  type ConsistencyRun,
  consistencyAccessOf,
  type Delegation,
  delegationModulesOf,
  lendingModulesOf,
  minorUnitsOf,
  periodOf,
  readsThresholds,
  revocable,
  setsThresholds,
  sortDelegations,
} from './controls'

const delegation = (status: Delegation['status'], createdAt: string): Delegation => ({
  id: `${status}-${createdAt}`,
  permission: 'ledger:entry:approve',
  delegatorId: 'a',
  delegateId: 'b',
  startsAt: '2026-09-01T00:00:00.000Z',
  endsAt: '2026-09-30T23:59:59.999Z',
  reason: null,
  status,
  createdAt,
  revokedAt: null,
  revokedBy: null,
})

describe('whom the controls screen asks', () => {
  const roles = [
    { module: 'ledger', role: 'viewer' },
    { module: 'treasury', role: 'admin' },
    { module: 'procurement', role: 'approver' },
    { module: 'inventory', role: 'auditor' },
    { module: 'reporting', role: 'viewer' },
  ]

  it('reads delegations wherever the person holds a role, and lends only where they decide', () => {
    expect(delegationModulesOf(roles)).toEqual(['procurement', 'inventory', 'ledger', 'treasury'])
    expect(lendingModulesOf(roles)).toEqual(['procurement', 'treasury'])
    // Only a Fiscal admin approves a rule change, so only an admin lends it (Phase 88).
    expect(lendingModulesOf([{ module: 'fiscal', role: 'issuer' }])).toEqual([])
    expect(lendingModulesOf([{ module: 'fiscal', role: 'admin' }])).toEqual(['fiscal'])
    expect(delegationModulesOf([{ module: 'sales', role: 'admin' }])).toEqual([])
  })

  it('shows thresholds to any role in Ledger or Treasury, and lets only their admins set one', () => {
    expect(readsThresholds(roles)).toEqual(['ledger', 'treasury'])
    expect(setsThresholds(roles)).toEqual(['treasury'])
  })

  it('reads consistency runs as a Reporting reader and starts one only as one who reconciles', () => {
    expect(consistencyAccessOf(roles)).toEqual({ read: true, run: false })
    expect(consistencyAccessOf([{ module: 'reporting', role: 'analyst' }])).toEqual({
      read: true,
      run: true,
    })
    expect(consistencyAccessOf([{ module: 'reporting', role: 'auditor' }])).toEqual({
      read: false,
      run: false,
    })
    expect(consistencyAccessOf([{ module: 'reporting', role: 'admin' }])).toEqual({
      read: true,
      run: true,
    })
    expect(consistencyAccessOf([])).toEqual({ read: false, run: false })
  })
})

describe('delegations', () => {
  it('span whole days in UTC, and refuse an end before the start', () => {
    expect(periodOf('2026-10-01', '2026-10-15')).toEqual({
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-10-15T23:59:59.999Z',
    })
    expect(periodOf('2026-10-15', '2026-10-01')).toBeNull()
    expect(periodOf('', '2026-10-01')).toBeNull()
  })

  it('list live ones first, newest first, and revoke only those not yet over', () => {
    const sorted = sortDelegations([
      delegation('ended', '2026-09-03'),
      delegation('active', '2026-09-01'),
      delegation('scheduled', '2026-09-05'),
      delegation('active', '2026-09-04'),
      delegation('revoked', '2026-09-06'),
    ])
    expect(sorted.map((entry) => entry.id)).toEqual([
      'active-2026-09-04',
      'active-2026-09-01',
      'scheduled-2026-09-05',
      'ended-2026-09-03',
      'revoked-2026-09-06',
    ])
    expect(sorted.map(revocable)).toEqual([true, true, true, false, false])
  })
})

describe('thresholds', () => {
  it('turn a typed amount into minor units, with either convention', () => {
    expect(minorUnitsOf('1000')).toBe('100000')
    expect(minorUnitsOf('1.000,00')).toBe('100000')
    expect(minorUnitsOf('1,000.00')).toBe('100000')
    expect(minorUnitsOf('1.234.567,8')).toBe('123456780')
    expect(minorUnitsOf(' 12.05 ')).toBe('1205')
    expect(minorUnitsOf('0,5')).toBe('50')
    expect(minorUnitsOf('1.000')).toBe('100000')
  })

  it('refuse what is not an amount', () => {
    for (const typed of ['', '-1', '1.23.4', 'abc', '1e5', '1.000.00', '1,5,0'])
      expect(minorUnitsOf(typed), typed).toBeNull()
  })
})

describe('consistency runs', () => {
  it('point at the checks that need a person', () => {
    const run: ConsistencyRun = {
      runId: 'r',
      trigger: 'scheduled',
      outcome: 'inconsistent',
      checks: [
        {
          check: 'receivables-control',
          outcome: 'matched',
          compared: 1,
          differences: [],
          reason: null,
        },
        {
          check: 'cash-accounts',
          outcome: 'differences',
          compared: 1,
          differences: [{ key: 'BRL', owner: '322350', ledger: '348600' }],
          reason: null,
        },
        {
          check: 'inventory-accounts',
          outcome: 'not-applicable',
          compared: 0,
          differences: [],
          reason: 'unmapped',
        },
        {
          check: 'audit-chains',
          outcome: 'unread',
          compared: 0,
          differences: [],
          reason: 'timeout',
        },
      ],
      pendingPostings: 0,
      startedBy: 'service:reporting',
      startedAt: '2026-09-28T19:37:19.906Z',
      finishedAt: '2026-09-28T19:37:19.938Z',
    }
    expect(attentionOf(run).map((check) => check.check)).toEqual(['cash-accounts', 'audit-chains'])
  })
})
