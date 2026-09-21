import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import {
  PartyAddress,
  PartyEmail,
  PartyName,
  PartyPhone,
  PartyRoles,
  TaxId,
} from '../value-objects/party-values'
import { Party } from './party'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-16T12:00:00Z')

function supplier() {
  const party = Party.register({
    tenantId: 'tenant-a',
    kind: 'organization',
    legalName: valid(PartyName.create('Torrefação Serra LTDA')),
    tradeName: null,
    taxId: valid(TaxId.create('12.345.678/0001-95', 'organization')),
    email: valid(PartyEmail.create('compras@serra.example')),
    phone: valid(PartyPhone.create('+55 11 99999-0000')),
    address: valid(PartyAddress.create('Rua das Flores, 10, São Paulo')),
    roles: valid(PartyRoles.of(['supplier'])),
    now,
  })
  party.pullDomainEvents()
  return party
}

describe('party roles', () => {
  it('lets one party be a supplier and a customer at once', () => {
    const party = supplier()
    expect(party.grant('customer', now).isRight()).toBe(true)
    expect(party.holds('customer')).toBe(true)
    expect(party.holds('supplier')).toBe(true)
  })

  it('refuses a role the party already holds', () => {
    expect(supplier().grant('supplier', now).isLeft()).toBe(true)
  })

  it('announces the complete role set with each change', () => {
    const party = supplier()
    party.grant('customer', now)
    const [event] = party.pullDomainEvents()
    expect(event?.eventType).toBe('parties.party.role-granted')
    expect(event?.payloadOf()).toMatchObject({ role: 'customer', roles: ['customer', 'supplier'] })
  })

  it('keeps the party when its last role is revoked', () => {
    const party = supplier()
    expect(party.revoke('supplier', now).isRight()).toBe(true)
    expect(party.isActive()).toBe(true)
  })
})

describe('party erasure', () => {
  it('announces erasure without any personal data in the payload', () => {
    const party = supplier()
    expect(party.erase(now).isRight()).toBe(true)
    const [event] = party.pullDomainEvents()
    expect(event?.eventType).toBe('parties.party.erased')
    expect(Object.keys(event?.payloadOf() ?? {})).toEqual(['partyId'])
  })

  it('refuses edits and roles once erased', () => {
    const party = supplier()
    party.erase(now)
    expect(party.grant('customer', now).isLeft()).toBe(true)
    expect(party.erase(now).isLeft()).toBe(true)
  })
})

describe('party values', () => {
  it('ties the tax identifier length to the kind of party', () => {
    expect(TaxId.create('123.456.789-01', 'person').isRight()).toBe(true)
    expect(TaxId.create('123.456.789-01', 'organization').isLeft()).toBe(true)
    expect(TaxId.create('12.345.678/0001-95', 'person').isLeft()).toBe(true)
  })

  it('preserves alphanumeric CNPJ in the canonical and encrypted-index input', () => {
    expect(valid(TaxId.create('00.000.000/e08g-12', 'organization')).value).toBe('00000000E08G12')
    expect(TaxId.create('00.000.000/E08G-AA', 'organization').isLeft()).toBe(true)
    expect(TaxId.create('00.000.000/E08@-12', 'organization').isLeft()).toBe(true)
  })

  it('rejects a role outside the published set', () => {
    expect(PartyRoles.of(['customer', 'landlord']).isLeft()).toBe(true)
  })

  it('treats roles as a set', () => {
    expect(valid(PartyRoles.of(['supplier', 'customer', 'supplier'])).values).toEqual([
      'customer',
      'supplier',
    ])
  })
})
