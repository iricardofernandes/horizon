import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import type { DomainEvent } from '@/core/events/domain-event'
import type { Party } from '@/domain/entities/party'
import type { Lookalike } from '@/domain/repositories/parties-repositories'
import {
  type LookupField,
  lookupEmail,
  lookupName,
  lookupPhone,
} from '@/domain/value-objects/party-lookup'
import type { PartiesScope, PartiesUnitOfWork } from '../ports/unit-of-work'
import {
  ChangePartyRoleUseCase,
  ChangePartyStatusUseCase,
  DescribePartyFiscalProfileUseCase,
  DescribePartyUseCase,
  ErasePartyUseCase,
  FindLookalikePartiesUseCase,
  IdentifyPartyUseCase,
  RegisterPartyUseCase,
  RepublishPartiesUseCase,
} from './manage-parties'

/** Tenant-scoped in-memory registry (ADR 0014); lookups compare the normalized forms. */
class InMemoryParties implements PartiesUnitOfWork {
  readonly rows = new Map<string, Party>()
  readonly events: DomainEvent[] = []

  inTenant<T>(tenantId: string, work: (scope: PartiesScope) => Promise<T>): Promise<T> {
    const mine = () => [...this.rows.values()].filter((party) => party.belongsTo(tenantId))
    const keep = (party: Party) => {
      this.rows.set(party.id.toString(), party)
      this.events.push(...party.pullDomainEvents())
    }
    return work({
      tenantId,
      parties: {
        findById: async (id) => mine().find((party) => party.id.toString() === id) ?? null,
        findByDocument: async (document) =>
          document.indexInput === null
            ? null
            : (mine().find((party) => party.document().indexInput === document.indexInput) ?? null),
        findLookalikes: async (probe, limit) =>
          mine()
            .filter((party) => !party.isErased())
            .map((party): Lookalike => {
              const row = party.lookupProbe()
              const matchedOn: LookupField[] = []
              const same = (a: string | null, b: string | null) => a !== null && a === b
              if (same(party.document().indexInput, probe.document.indexInput))
                matchedOn.push('document')
              if (same(lookupName(row.legalName), lookupName(probe.legalName)))
                matchedOn.push('name')
              if (same(lookupEmail(row.email), lookupEmail(probe.email))) matchedOn.push('email')
              if (same(lookupPhone(row.phone), lookupPhone(probe.phone))) matchedOn.push('phone')
              return { party, matchedOn }
            })
            .filter((match) => match.matchedOn.length > 0)
            .slice(0, limit),
        listAfter: async (afterId, limit) =>
          mine()
            .sort((a, b) => a.id.toString().localeCompare(b.id.toString()))
            .filter((party) => afterId === null || party.id.toString() > afterId)
            .slice(0, limit),
        create: async (party) => keep(party),
        save: async (party) => keep(party),
      },
      events: { append: async (event) => void this.events.push(event) },
    })
  }
}

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const clock = { now: () => new Date('2026-09-27T12:00:00Z') }
const tenantId = 'tenant-a'
const reachable = {
  email: 'compras@acme.example',
  phone: '+49 30 1234 5678',
  address: 'Hauptstraße 1, 10115 Berlin',
}

function setup() {
  const registry = new InMemoryParties()
  return {
    registry,
    register: new RegisterPartyUseCase(registry, clock),
    describe: new DescribePartyUseCase(registry, clock),
    identify: new IdentifyPartyUseCase(registry, clock),
    role: new ChangePartyRoleUseCase(registry, clock),
    status: new ChangePartyStatusUseCase(registry, clock),
    erase: new ErasePartyUseCase(registry, clock),
    fiscal: new DescribePartyFiscalProfileUseCase(registry, clock),
    lookalikes: new FindLookalikePartiesUseCase(registry),
  }
}

describe('registering parties with a typed document', () => {
  it('registers a foreign customer and keeps foreign documents unique per country', async () => {
    const { register } = setup()
    const document = { type: 'foreign', country: 'DE', number: 'HRB 1234' } as const
    const first = await register.execute({
      tenantId,
      kind: 'organization',
      legalName: 'Acme GmbH',
      document,
      roles: ['customer'],
      ...reachable,
    })
    expect(first.isRight()).toBe(true)
    const again = await register.execute({
      tenantId,
      kind: 'organization',
      legalName: 'Acme Germany',
      document: { ...document, number: 'hrb  1234' },
      roles: [],
    })
    expect(again.value).toMatchObject({ title: 'Conflict' })
    const elsewhere = await register.execute({
      tenantId,
      kind: 'organization',
      legalName: 'Acme Austria',
      document: { ...document, country: 'AT' },
      roles: [],
    })
    expect(elsewhere.isRight()).toBe(true)
  })

  it('accepts the taxId shorthand, refuses both forms at once, and refuses neither', async () => {
    const { register } = setup()
    const base = { tenantId, kind: 'person' as const, legalName: 'Maria Souza', roles: [] }
    expect((await register.execute({ ...base, taxId: '123.456.789-01' })).isRight()).toBe(true)
    const both = await register.execute({
      ...base,
      taxId: '98765432100',
      document: { type: 'none' },
    })
    expect(both.value).toMatchObject({ field: '/document' })
    expect((await register.execute(base)).value).toMatchObject({ field: '/document' })
  })

  it('never lets two parties without a document collide on it', async () => {
    const { register } = setup()
    const base = {
      tenantId,
      kind: 'person' as const,
      roles: ['prospect'],
      document: { type: 'none' } as const,
    }
    expect((await register.execute({ ...base, legalName: 'João' })).isRight()).toBe(true)
    expect((await register.execute({ ...base, legalName: 'João' })).isRight()).toBe(true)
  })

  it('refuses a customer that cannot be reached and a malformed optional field', async () => {
    const { register } = setup()
    const base = {
      tenantId,
      kind: 'person' as const,
      legalName: 'Maria Souza',
      document: { type: 'none' } as const,
    }
    expect((await register.execute({ ...base, roles: ['customer'] })).value).toMatchObject({
      field: '/roles',
    })
    expect(
      (await register.execute({ ...base, roles: [], email: 'not-an-email' })).value,
    ).toMatchObject({ field: '/email' })
    expect(
      (await register.execute({ ...base, roles: [], email: '  ', phone: null })).isRight(),
    ).toBe(true)
  })
})

describe('completing a party later', () => {
  async function prospect(context: ReturnType<typeof setup>) {
    return valid(
      await context.register.execute({
        tenantId,
        kind: 'organization',
        legalName: 'Acme Comércio Ltda',
        document: { type: 'none' },
        roles: ['prospect'],
      }),
    ).partyId
  }

  it('identifies a prospect once and refuses a document another party holds', async () => {
    const context = setup()
    const partyId = await prospect(context)
    valid(
      await context.register.execute({
        tenantId,
        kind: 'organization',
        legalName: 'Serra',
        taxId: '12345678000195',
        roles: [],
      }),
    )
    const taken = await context.identify.execute({
      tenantId,
      partyId,
      document: { type: 'cnpj', number: '12.345.678/0001-95' },
    })
    expect(taken.value).toMatchObject({ title: 'Conflict' })
    const cnpj = { type: 'cnpj', number: '00.000.000/E08G-12' } as const
    expect((await context.identify.execute({ tenantId, partyId, document: cnpj })).isRight()).toBe(
      true,
    )
    expect((await context.identify.execute({ tenantId, partyId, document: cnpj })).isLeft()).toBe(
      true,
    )
    expect(
      (
        await context.identify.execute({
          tenantId,
          partyId,
          document: { type: 'cpf', number: '1' },
        })
      ).value,
    ).toMatchObject({ field: '/document/number' })
    expect(
      (
        await context.identify.execute({
          tenantId,
          partyId: 'missing',
          document: { type: 'none' },
        })
      ).value,
    ).toMatchObject({ title: 'Resource not found' })
  })

  it('grants customer only after the prospect can be reached', async () => {
    const context = setup()
    const partyId = await prospect(context)
    const grant = () =>
      context.role.execute({ tenantId, partyId, role: 'customer', operation: 'grant' })
    expect((await grant()).value).toMatchObject({ title: 'Conflict' })
    valid(
      await context.describe.execute({
        tenantId,
        partyId,
        legalName: 'Acme Comércio',
        ...reachable,
      }),
    )
    expect((await grant()).isRight()).toBe(true)
    const cleared = await context.describe.execute({
      tenantId,
      partyId,
      legalName: 'Acme Comércio',
    })
    expect(cleared.value).toMatchObject({ field: '/roles' })
    expect(
      (
        await context.role.execute({ tenantId, partyId, role: 'landlord', operation: 'grant' })
      ).isLeft(),
    ).toBe(true)
    expect(
      (await context.describe.execute({ tenantId, partyId, legalName: 'x' })).value,
    ).toMatchObject({ field: '/legalName' })
  })

  it('refuses a fiscal profile to a party without a CPF or a CNPJ', async () => {
    const context = setup()
    const partyId = await prospect(context)
    const profile = {
      effectiveFrom: '2026-09-27',
      stateRegistration: null,
      municipalRegistration: null,
      taxpayerIndicator: 'non-contributor' as const,
      finalConsumer: true,
      address: {
        street: 'Rua A',
        number: '1',
        complement: null,
        district: 'Centro',
        city: 'São Paulo',
        municipalityCode: '3550308',
        state: 'SP',
        postalCode: '01001000',
        country: 'BR',
      },
    }
    const refused = await context.fiscal.execute({ tenantId, partyId, profile })
    expect(refused.value).toMatchObject({ title: 'Conflict' })
    valid(
      await context.identify.execute({
        tenantId,
        partyId,
        document: { type: 'cnpj', number: '12345678000195' },
      }),
    )
    expect(valid(await context.fiscal.execute({ tenantId, partyId, profile }))).toBe(1)
  })

  it('deactivates, reactivates and erases through the same party lookup', async () => {
    const context = setup()
    const partyId = await prospect(context)
    expect((await context.status.execute({ tenantId, partyId, active: false })).isRight()).toBe(
      true,
    )
    expect((await context.status.execute({ tenantId, partyId, active: true })).isRight()).toBe(true)
    expect((await context.erase.execute({ tenantId, partyId })).isRight()).toBe(true)
    expect(context.registry.events.at(-1)?.eventType).toBe('parties.party.erased')
  })
})

describe('warning about lookalikes', () => {
  it('finds a party by normalized name, email, phone or document, and never an erased one', async () => {
    const context = setup()
    const { partyId } = valid(
      await context.register.execute({
        tenantId,
        kind: 'organization',
        legalName: 'Acme Comércio Ltda.',
        document: { type: 'foreign', country: 'US', number: '12-3456789' },
        roles: ['prospect'],
        email: 'Sales@Acme.example',
      }),
    )
    const byName = valid(await context.lookalikes.execute({ tenantId, legalName: 'ACME COMERCIO' }))
    expect(byName.map((match) => [match.party.id.toString(), match.matchedOn])).toEqual([
      [partyId, ['name']],
    ])
    const byEverything = valid(
      await context.lookalikes.execute({
        tenantId,
        legalName: 'Other Name',
        email: 'sales@acme.example',
        document: { type: 'foreign', country: 'US', number: '12-3456789' },
      }),
    )
    expect(byEverything[0]?.matchedOn).toEqual(['document', 'email'])
    expect(
      valid(await context.lookalikes.execute({ tenantId: 'tenant-b', legalName: 'Acme' })),
    ).toEqual([])
    valid(await context.erase.execute({ tenantId, partyId }))
    expect(
      valid(await context.lookalikes.execute({ tenantId, legalName: 'Acme Comércio' })),
    ).toEqual([])
  })

  it('refuses a probe without a usable name or with a malformed document', async () => {
    const { lookalikes } = setup()
    expect((await lookalikes.execute({ tenantId, legalName: 'x' })).isLeft()).toBe(true)
    expect(
      (
        await lookalikes.execute({
          tenantId,
          legalName: 'Acme',
          document: { type: 'foreign', country: 'BR', number: '1' },
        })
      ).isLeft(),
    ).toBe(true)
  })
})

describe('republishing a tenant', () => {
  it('announces every live party once, with its kind, across pages', async () => {
    const context = setup()
    for (const legalName of ['Alfa', 'Beta', 'Gama'])
      valid(
        await context.register.execute({
          tenantId,
          kind: 'organization',
          legalName,
          document: { type: 'none' },
          roles: ['prospect'],
        }),
      )
    const erased = valid(
      await context.register.execute({
        tenantId,
        kind: 'person',
        legalName: 'Delta',
        document: { type: 'none' },
        roles: [],
      }),
    ).partyId
    valid(await context.erase.execute({ tenantId, partyId: erased }))
    context.registry.events.length = 0

    const result = await new RepublishPartiesUseCase(context.registry, clock).execute({
      tenantId,
      pageSize: 2,
    })
    expect(result).toEqual({ republished: 3 })
    expect(context.registry.events.map((event) => event.eventType)).toEqual([
      'parties.party.updated',
      'parties.party.updated',
      'parties.party.updated',
    ])
    expect(context.registry.events[0]?.payloadOf()).toMatchObject({ kind: 'organization' })
  })
})
