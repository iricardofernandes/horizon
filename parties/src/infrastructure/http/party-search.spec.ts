import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PartySnapshot } from '@/domain/entities/party'
import { matchesSearch } from './parties.controller'

const party = {
  id: randomUUID(),
  tenantId: randomUUID(),
  kind: 'organization',
  legalName: 'Café São Paulo LTDA',
  tradeName: 'Torrefação Paulista',
  document: { type: 'cnpj', number: '12345678000195', country: null },
  email: 'compras@cafesp.example',
  phone: null,
  address: null,
  fiscalProfile: null,
  fiscalProfileRevision: 0,
  roles: ['customer'],
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as PartySnapshot

describe('searching parties', () => {
  it('finds a term in the names or email, ignoring case and accents', () => {
    expect(matchesSearch(party, 'cafe sao')).toBe(true)
    expect(matchesSearch(party, 'PAULISTA')).toBe(true)
    expect(matchesSearch(party, 'compras@')).toBe(true)
    expect(matchesSearch(party, 'globex')).toBe(false)
  })

  it('finds a document by its digits, and never an erased party', () => {
    expect(matchesSearch(party, '12.345.678')).toBe(true)
    expect(matchesSearch(party, '999')).toBe(false)
    expect(matchesSearch({ ...party, status: 'erased' } as PartySnapshot, 'cafe')).toBe(false)
  })
})
