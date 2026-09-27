import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { Segment, Tags } from '../value-objects/crm-values'
import { Account, type PartyFacts } from './account'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-27T12:00:00Z')
const prospect: PartyFacts = {
  kind: 'organization',
  legalName: 'Acme GmbH',
  tradeName: null,
  roles: ['prospect'],
  documentType: 'foreign',
  documentCountry: 'DE',
  active: true,
}

function account(party: PartyFacts = prospect) {
  const projected = Account.project({ tenantId: 'tenant-a', party, now }, new UniqueEntityID())
  if (!projected) throw new Error('not an account')
  return projected
}

describe('account projection', () => {
  it('is an account only while the party holds a CRM role', () => {
    expect(
      Account.project(
        { tenantId: 't', party: { ...prospect, roles: ['supplier'] }, now },
        new UniqueEntityID(),
      ),
    ).toBeNull()
    for (const role of ['prospect', 'customer', 'partner'])
      expect(snapshotOf(account({ ...prospect, roles: [role] })).status).toBe('active')
  })

  it('stays, inactive, when the party loses the role or is deactivated', () => {
    const acme = account()
    acme.refresh({ ...prospect, roles: ['supplier'] }, now)
    expect(snapshotOf(acme).status).toBe('inactive')
    acme.refresh({ ...prospect, roles: ['customer'], active: false }, now)
    expect(snapshotOf(acme).status).toBe('inactive')
    expect(acme.acceptsContacts()).toBe(false)
    acme.refresh({ ...prospect, roles: ['customer'] }, now)
    expect(acme.acceptsContacts()).toBe(true)
  })

  it('keeps the kind and document an older update does not carry', () => {
    const acme = account()
    acme.refresh({ ...prospect, kind: null, documentType: null, documentCountry: null }, now)
    expect(snapshotOf(acme)).toMatchObject({
      kind: 'organization',
      documentType: 'foreign',
      documentCountry: 'DE',
    })
  })

  it('forgets the names on erasure and is never brought back', () => {
    const acme = account({ ...prospect, tradeName: 'Acme' })
    expect(acme.erase(now)).toBe(true)
    expect(acme.erase(now)).toBe(false)
    expect(acme.refresh(prospect, now)).toBe(false)
    expect(snapshotOf(acme)).toMatchObject({ legalName: null, tradeName: null, status: 'erased' })
    expect(acme.describe({ segment: null }, now).isLeft()).toBe(true)
  })
})

describe('account profile', () => {
  it('reports only the fields that changed', () => {
    const acme = account()
    const segment = valid(Segment.create('  Indústria  '))
    expect(
      valid(
        acme.describe(
          { ownerId: 'u1', segment, tags: valid(Tags.of(['VIP', 'vip ', 'sul'])) },
          now,
        ),
      ),
    ).toEqual(['ownerId', 'segment', 'tags'])
    expect(snapshotOf(acme)).toMatchObject({
      ownerId: 'u1',
      segment: 'Indústria',
      tags: ['sul', 'vip'],
    })
    expect(
      valid(
        acme.describe(
          {
            ownerId: 'u1',
            segment: valid(Segment.create('Indústria')),
            tags: valid(Tags.of(['sul', 'vip'])),
          },
          now,
        ),
      ),
    ).toEqual([])
    expect(valid(acme.describe({ segment: null, ownerId: null }, now))).toEqual([
      'ownerId',
      'segment',
    ])
  })

  it('bounds segments and tags', () => {
    expect(Segment.create('').isLeft()).toBe(true)
    expect(Segment.create('x'.repeat(81)).isLeft()).toBe(true)
    expect(Tags.of(Array.from({ length: 21 }, (_, index) => `t${index}`)).isLeft()).toBe(true)
    expect(Tags.of(['x'.repeat(41)]).isLeft()).toBe(true)
    expect(Tags.of(['  ']).isLeft()).toBe(true)
  })
})
