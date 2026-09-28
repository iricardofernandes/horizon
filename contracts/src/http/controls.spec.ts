import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { MODULES, permissionIdSchema } from '../roles'
import {
  auditPageSchema,
  auditQuerySchema,
  delegablePermissions,
  delegationSchema,
  dutyConflictsOf,
  grantDelegationSchema,
  SEGREGATION_OF_DUTIES,
  SEGREGATION_OF_DUTIES_TYPE,
  segregationOfDutiesProblemSchema,
} from './controls'

describe('the segregation of duties matrix', () => {
  it('names well-formed permissions of the module that enforces each pair', () => {
    for (const pair of SEGREGATION_OF_DUTIES) {
      expect(MODULES).toContain(pair.module)
      for (const permission of [pair.perform, pair.approve]) {
        expect(permissionIdSchema.safeParse(permission).success).toBe(true)
        expect(permission.startsWith(`${pair.module}:`)).toBe(true)
      }
      expect(pair.perform).not.toBe(pair.approve)
      expect(pair.id.startsWith(`${pair.module}.`)).toBe(true)
    }
  })

  it('has one id per pair and no pair twice', () => {
    const ids = SEGREGATION_OF_DUTIES.map((pair) => pair.id)
    expect(new Set(ids).size).toBe(ids.length)
    const pairs = SEGREGATION_OF_DUTIES.map((pair) => `${pair.perform}|${pair.approve}`)
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  it('covers the five modules that approve, and lends only deciding permissions', () => {
    expect(new Set(SEGREGATION_OF_DUTIES.map((pair) => pair.module))).toEqual(
      new Set(['financial', 'procurement', 'inventory', 'ledger', 'treasury']),
    )
    expect(delegablePermissions('procurement')).toEqual([
      'procurement:requisition:approve',
      'procurement:order:approve',
    ])
    expect(delegablePermissions('sales')).toEqual([])
    expect(dutyConflictsOf('inventory').map((pair) => pair.id)).toEqual([
      'inventory.adjustment',
      'inventory.count',
    ])
  })

  it('refuses with one shape everywhere', () => {
    const problem = {
      type: SEGREGATION_OF_DUTIES_TYPE,
      title: 'Segregation of duties',
      status: 403,
      detail: 'the person who asked for approval cannot decide it',
      code: 'segregation-of-duties',
      pair: 'financial.payable',
    }
    expect(segregationOfDutiesProblemSchema.parse(problem)).toEqual(problem)
    expect(segregationOfDutiesProblemSchema.safeParse({ ...problem, status: 409 }).success).toBe(
      false,
    )
  })
})

describe('delegations', () => {
  it('accepts a grant and refuses unknown fields', () => {
    const grant = {
      permission: 'financial:payable:approve',
      delegateId: randomUUID(),
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-10-15T00:00:00.000Z',
    }
    expect(grantDelegationSchema.parse(grant)).toEqual(grant)
    expect(grantDelegationSchema.safeParse({ ...grant, delegatorId: 'x' }).success).toBe(false)
    expect(grantDelegationSchema.safeParse({ ...grant, permission: 'approve' }).success).toBe(false)
  })

  it('describes a delegation with its state', () => {
    const delegation = {
      id: randomUUID(),
      permission: 'treasury:transfer:approve',
      delegatorId: randomUUID(),
      delegateId: randomUUID(),
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-10-15T00:00:00.000Z',
      reason: null,
      status: 'revoked',
      createdAt: '2026-09-28T00:00:00.000Z',
      revokedAt: '2026-10-02T00:00:00.000Z',
      revokedBy: randomUUID(),
    }
    expect(delegationSchema.parse(delegation)).toEqual(delegation)
  })
})

describe('the audit read contract', () => {
  it('coerces the limit and bounds it', () => {
    expect(auditQuerySchema.parse({ limit: '20' }).limit).toBe(20)
    expect(auditQuerySchema.parse({}).limit).toBe(50)
    expect(auditQuerySchema.safeParse({ limit: '500' }).success).toBe(false)
    expect(auditQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false)
    expect(auditQuerySchema.safeParse({ since: '2026-01-01' }).success).toBe(false)
  })

  it('carries the chain verdict with every page', () => {
    const page = {
      data: [
        {
          sequence: 7,
          occurredAt: '2026-09-28T12:00:00.000Z',
          actor: randomUUID(),
          action: 'payable.approved',
          subjectType: 'title',
          subjectId: randomUUID(),
          requestId: null,
          traceId: null,
          details: { onBehalfOf: randomUUID() },
          hash: 'a'.repeat(64),
        },
      ],
      page: { hasMore: false },
      chain: { status: 'broken', checked: 1, broken: [7] },
    }
    expect(auditPageSchema.parse(page)).toEqual(page)
    expect(
      auditPageSchema.safeParse({ ...page, chain: { status: 'unknown', checked: 0, broken: [] } })
        .success,
    ).toBe(false)
  })
})
