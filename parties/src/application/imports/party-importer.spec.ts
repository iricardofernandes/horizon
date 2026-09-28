import { describe, expect, it } from 'vitest'
import type { Party } from '@/domain/entities/party'
import type { ImportRecord } from '@/domain/imports/import-values'
import type { PartiesScope, PartiesUnitOfWork } from '../ports/unit-of-work'
import { PartyImporter } from './party-importer'
import type { RowKey } from './ports'

const TENANT = '01900000-0000-7000-8000-000000000001'
const context = {
  tenantId: TENANT,
  actor: 'u',
  requestId: null,
  numbers: 'pt-BR',
  dates: 'pt-BR',
} as const

/** Just enough of the registry to register a party once per document. */
class Registry implements PartiesUnitOfWork {
  readonly parties: Party[] = []
  readonly keys: RowKey[] = []

  inTenant<T>(tenantId: string, work: (scope: PartiesScope) => Promise<T>): Promise<T> {
    return work({
      tenantId,
      parties: {
        findById: async () => null,
        findByDocument: async (document) =>
          this.parties.find((party) => party.document().indexInput === document.indexInput) ?? null,
        findLookalikes: async () => [],
        listAfter: async () => [],
        create: async (party) => {
          this.parties.push(party)
        },
        save: async () => {},
      },
      events: { append: async () => {} },
    })
  }
}

function setup() {
  const registry = new Registry()
  const importer = new PartyImporter({ now: () => new Date('2026-09-28T12:00:00Z') }, (key) => {
    registry.keys.push(key)
    return registry
  })
  return { registry, importer }
}

const row = (values: Partial<Record<string, string>>): ImportRecord => ({
  kind: null,
  legalName: null,
  tradeName: null,
  documentType: null,
  documentNumber: null,
  documentCountry: null,
  email: null,
  phone: null,
  address: null,
  roles: null,
  ...values,
})

const supplier = row({
  kind: 'PJ',
  legalName: 'Torrefação Serra LTDA',
  documentNumber: '12.345.678/0001-95',
  email: 'compras@serra.example',
  phone: '(11) 99999-0000',
  address: 'Rua das Flores, 10, São Paulo',
  roles: 'fornecedor | cliente',
})

describe('validating a party row', () => {
  it('accepts a Brazilian company, inferring a CNPJ and translating the roles', async () => {
    const session = await setup().importer.session(context)
    const outcome = session.validate(supplier)
    expect(outcome.isRight() && outcome.value).toMatchObject({
      kind: 'organization',
      document: { type: 'cnpj', number: '12.345.678/0001-95' },
      roles: ['supplier', 'customer'],
    })
    expect(outcome.isRight() && session.uniqueKey(outcome.value)).toBe('cnpj:12345678000195')
  })

  it('accepts a prospect known by name alone, and a foreign supplier', async () => {
    const session = await setup().importer.session(context)
    const prospect = session.validate(row({ kind: 'pessoa', legalName: 'Ana', roles: 'prospect' }))
    expect(prospect.isRight() && prospect.value.document).toEqual({ type: 'none' })
    expect(prospect.isRight() && session.uniqueKey(prospect.value)).toBeNull()
    const foreign = session.validate(
      row({
        ...supplier,
        documentType: 'foreign',
        documentNumber: 'DE123',
        documentCountry: 'de',
      }),
    )
    expect(foreign.isRight()).toBe(true)
  })

  it('names every field that is wrong', async () => {
    const session = await setup().importer.session(context)
    const outcome = session.validate(
      row({
        kind: 'PF',
        legalName: 'A',
        documentNumber: '123456789012',
        email: 'nope',
        roles: 'vendedor',
      }),
    )
    expect(outcome.isLeft() && outcome.value.map((issue) => issue.field)).toEqual([
      'legalName',
      'documentNumber',
      'roles',
    ])
  })

  it('refuses an unknown kind, a document type it does not know and a none with a number', async () => {
    const session = await setup().importer.session(context)
    expect(session.validate(row({ kind: 'robô', legalName: 'Ana' })).isLeft()).toBe(true)
    const odd = session.validate(
      row({ kind: 'PF', legalName: 'Ana', documentType: 'rg', documentNumber: '1' }),
    )
    expect(odd.isLeft() && odd.value[0]?.field).toBe('documentType')
    const none = session.validate(
      row({ kind: 'PF', legalName: 'Ana', documentType: 'none', documentNumber: '1' }),
    )
    expect(none.isLeft()).toBe(true)
    const noNumber = session.validate(row({ kind: 'PF', legalName: 'Ana', documentType: 'cpf' }))
    expect(noNumber.isLeft() && noNumber.value[0]?.field).toBe('documentNumber')
  })

  it('refuses a CPF for a company and a customer with no way to reach it', async () => {
    const session = await setup().importer.session(context)
    const cpf = session.validate(
      row({ ...supplier, documentType: 'cpf', documentNumber: '12345678901' }),
    )
    expect(cpf.isLeft() && cpf.value[0]?.field).toBe('documentType')
    const unreachable = session.validate(row({ kind: 'PJ', legalName: 'Serra', roles: 'cliente' }))
    expect(unreachable.isLeft() && unreachable.value[0]?.field).toBe('roles')
  })
})

describe('documents a spreadsheet stored as numbers', () => {
  it('restores the leading zeros of a CPF or CNPJ', async () => {
    const session = await setup().importer.session(context)
    const person = session.validate(
      row({ kind: 'PF', legalName: 'Ana Souza', documentNumber: '1234567890', roles: 'prospect' }),
    )
    expect(person.isRight() && person.value.document).toEqual({
      type: 'cpf',
      number: '01234567890',
    })
    const short = session.validate(
      row({ kind: 'PJ', legalName: 'Curta', documentNumber: '123', roles: 'prospect' }),
    )
    expect(short.isLeft() && short.value[0]?.field).toBe('documentNumber')
  })
})

describe('writing a party row', () => {
  it('registers the party through the use case, keyed by the row', async () => {
    const { importer, registry } = setup()
    const session = await importer.session(context)
    const command = session.validate(supplier)
    if (command.isLeft()) throw new Error()
    const written = await importer.write(command.value, { jobId: 'job', line: 2 }, context)
    expect(written.isRight()).toBe(true)
    expect(registry.parties).toHaveLength(1)
    expect(registry.keys).toEqual([{ jobId: 'job', line: 2 }])
    const again = await importer.write(command.value, { jobId: 'job', line: 3 }, context)
    expect(again.isLeft() && again.value[0]?.message).toContain('grant it the role instead')
  })
})
