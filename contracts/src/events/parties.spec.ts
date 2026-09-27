import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { partyRegistered, partyRegisteredV2, partyUpdatedV2 } from './parties'

const base = {
  partyId: randomUUID(),
  kind: 'organization' as const,
  legalName: 'Acme GmbH',
  tradeName: null,
  roles: ['prospect'] as const,
}

describe('party events v2', () => {
  it('carries a foreign document type with its country and never the number', () => {
    const payload = {
      ...base,
      email: null,
      phone: null,
      address: null,
      documentType: 'foreign',
      documentCountry: 'DE',
    }
    expect(partyRegisteredV2.payload.safeParse(payload).success).toBe(true)
    expect(partyRegisteredV2.id).toBe('event:parties.party.registered:v2')
    expect(partyRegistered.payload.safeParse(payload).success).toBe(false)
  })

  it('ties the country to the foreign type in both directions', () => {
    const contact = { email: null, phone: null, address: null }
    expect(
      partyRegisteredV2.payload.safeParse({
        ...base,
        ...contact,
        documentType: 'foreign',
        documentCountry: null,
      }).success,
    ).toBe(false)
    expect(
      partyUpdatedV2.payload.safeParse({
        ...base,
        ...contact,
        documentType: 'cnpj',
        documentCountry: 'BR',
        active: true,
      }).success,
    ).toBe(false)
  })

  it('accepts a party with no document and only a name', () => {
    expect(
      partyUpdatedV2.payload.safeParse({
        partyId: base.partyId,
        legalName: 'Maria',
        tradeName: null,
        email: null,
        phone: null,
        address: null,
        documentType: 'none',
        documentCountry: null,
        roles: [],
        active: true,
      }).success,
    ).toBe(true)
  })
})
