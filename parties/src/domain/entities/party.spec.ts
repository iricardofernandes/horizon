import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { FiscalProfile } from '../value-objects/fiscal-profile'
import { lookupName, lookupPhone } from '../value-objects/party-lookup'
import {
  PartyAddress,
  PartyDocument,
  PartyEmail,
  PartyName,
  PartyPhone,
  PartyRoles,
} from '../value-objects/party-values'
import { Party } from './party'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-16T12:00:00Z')

const contact = {
  email: valid(PartyEmail.create('compras@serra.example')),
  phone: valid(PartyPhone.create('+55 11 99999-0000')),
  address: valid(PartyAddress.create('Rua das Flores, 10, São Paulo')),
}
const noContact = { email: null, phone: null, address: null }

function supplier() {
  const party = valid(
    Party.register({
      tenantId: 'tenant-a',
      kind: 'organization',
      legalName: valid(PartyName.create('Torrefação Serra LTDA')),
      tradeName: null,
      document: valid(PartyDocument.fromTaxId('12.345.678/0001-95', 'organization')),
      ...contact,
      roles: valid(PartyRoles.of(['supplier'])),
      now,
    }),
  )
  party.pullDomainEvents()
  return party
}

function prospect(document = PartyDocument.none()) {
  const party = valid(
    Party.register({
      tenantId: 'tenant-a',
      kind: 'organization',
      legalName: valid(PartyName.create('Acme GmbH')),
      tradeName: null,
      document,
      ...noContact,
      roles: valid(PartyRoles.of(['prospect'])),
      now,
    }),
  )
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

describe('parties without a Brazilian document', () => {
  it('registers a prospect known only by its name, and says so on the bus', () => {
    const party = valid(
      Party.register({
        tenantId: 'tenant-a',
        kind: 'organization',
        legalName: valid(PartyName.create('Acme GmbH')),
        tradeName: null,
        document: valid(
          PartyDocument.create({ type: 'foreign', country: 'de', number: 'hrb 1234' }),
        ),
        ...noContact,
        roles: valid(PartyRoles.of(['prospect'])),
        now,
      }),
    )
    const [event] = party.pullDomainEvents()
    expect(event?.eventVersion).toBe(2)
    expect(event?.payloadOf()).toMatchObject({
      documentType: 'foreign',
      documentCountry: 'DE',
      email: null,
      phone: null,
      address: null,
    })
    expect(JSON.stringify(event?.payloadOf())).not.toContain('HRB')
  })

  it('refuses a customer, supplier or carrier without email, phone and address', () => {
    for (const role of ['customer', 'supplier', 'carrier']) {
      const registered = Party.register({
        tenantId: 'tenant-a',
        kind: 'person',
        legalName: valid(PartyName.create('Maria Souza')),
        tradeName: null,
        document: PartyDocument.none(),
        ...contact,
        phone: null,
        roles: valid(PartyRoles.of([role])),
        now,
      })
      expect(registered.isLeft()).toBe(true)
    }
  })

  it('makes a foreign or undocumented party a customer once it can be reached', () => {
    const party = prospect()
    expect(party.grant('customer', now).isLeft()).toBe(true)
    const name = valid(PartyName.create('Acme GmbH'))
    expect(party.describe({ legalName: name, tradeName: null, ...contact }, now).isRight()).toBe(
      true,
    )
    expect(party.grant('customer', now).isRight()).toBe(true)
    expect(party.describe({ legalName: name, tradeName: null, ...noContact }, now).isLeft()).toBe(
      true,
    )
  })

  it('takes a document once, from none, matching its kind', () => {
    const party = prospect()
    const cpf = valid(PartyDocument.create({ type: 'cpf', number: '123.456.789-01' }))
    expect(party.identify(cpf, now).isLeft()).toBe(true)
    const cnpj = valid(PartyDocument.create({ type: 'cnpj', number: '12.345.678/0001-95' }))
    expect(party.identify(cnpj, now).isRight()).toBe(true)
    expect(party.document().type).toBe('cnpj')
    const [event] = party.pullDomainEvents()
    expect(event?.payloadOf()).toMatchObject({ documentType: 'cnpj', documentCountry: null })
    expect(party.identify(cnpj, now).isLeft()).toBe(true)
  })

  it('keeps fiscal profiles to parties with a CPF or a CNPJ', () => {
    const profile = valid(
      FiscalProfile.create({
        effectiveFrom: '2026-09-27',
        stateRegistration: null,
        municipalRegistration: null,
        taxpayerIndicator: 'non-contributor',
        finalConsumer: true,
        address: {
          street: 'Hauptstraße',
          number: '1',
          complement: null,
          district: 'Mitte',
          city: 'Berlin',
          municipalityCode: null,
          state: null,
          postalCode: '10115',
          country: 'DE',
        },
      }),
    )
    const foreign = valid(PartyDocument.create({ type: 'foreign', country: 'DE', number: 'X1' }))
    expect(prospect(foreign).describeFiscalProfile(profile, now).isLeft()).toBe(true)
    expect(prospect().describeFiscalProfile(profile, now).isLeft()).toBe(true)
  })
})

describe('party values', () => {
  it('ties the CPF and the CNPJ to the kind of party', () => {
    expect(PartyDocument.fromTaxId('123.456.789-01', 'person').isRight()).toBe(true)
    expect(PartyDocument.fromTaxId('123.456.789-01', 'organization').isLeft()).toBe(true)
    expect(PartyDocument.fromTaxId('12.345.678/0001-95', 'person').isLeft()).toBe(true)
    expect(
      PartyDocument.create({ type: 'cpf', number: '12345678901' }, 'organization').isLeft(),
    ).toBe(true)
  })

  it('preserves alphanumeric CNPJ in the canonical and encrypted-index input', () => {
    const cnpj = valid(PartyDocument.fromTaxId('00.000.000/e08g-12', 'organization'))
    expect(cnpj.number).toBe('00000000E08G12')
    expect(cnpj.indexInput).toBe('00000000E08G12')
    expect(PartyDocument.fromTaxId('00.000.000/E08G-AA', 'organization').isLeft()).toBe(true)
    expect(PartyDocument.fromTaxId('00.000.000/E08@-12', 'organization').isLeft()).toBe(true)
  })

  it('indexes a foreign document with its country and leaves none unindexed', () => {
    const foreign = valid(
      PartyDocument.create({ type: 'foreign', country: 'us', number: '12-3456789' }),
    )
    expect(foreign.indexInput).toBe('foreign:US:12-3456789')
    expect(PartyDocument.none().indexInput).toBeNull()
    expect(PartyDocument.create({ type: 'foreign', country: 'BR', number: '1' }).isLeft()).toBe(
      true,
    )
    expect(PartyDocument.create({ type: 'foreign', country: 'USA', number: '1' }).isLeft()).toBe(
      true,
    )
    expect(PartyDocument.create({ type: 'foreign', country: 'US', number: '#1' }).isLeft()).toBe(
      true,
    )
  })

  it('normalizes names and phones so lookalikes meet', () => {
    expect(lookupName('Acme Comércio Ltda.')).toBe(lookupName('ACME COMERCIO'))
    expect(lookupName('Serra S/A')).toBe('serra')
    expect(lookupName('Ltda')).toBeNull()
    expect(lookupPhone('+55 (11) 99999-0000')).toBe(lookupPhone('11 99999 0000'))
    expect(lookupPhone('+1 415 555 0100')).toBe('14155550100')
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
