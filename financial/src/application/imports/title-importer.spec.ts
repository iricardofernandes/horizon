import { describe, expect, it } from 'vitest'
import type { ImportRecord } from '@/domain/imports/import-values'
import type { FinancialUnitOfWork } from '../ports/unit-of-work'
import type { ImportActor } from './ports'
import { minorUnitsOf, TitleImporter } from './title-importer'

const PARTY = '01900000-0000-7000-8000-0000000000aa'
const context: ImportActor = {
  tenantId: '01900000-0000-7000-8000-000000000001',
  actor: 'admin-1',
  requestId: null,
  numbers: 'pt-BR',
  dates: 'pt-BR',
}
const unused = {} as FinancialUnitOfWork
const clock = { now: () => new Date('2026-09-28T12:00:00Z') }

const row = (values: Record<string, string | null>): ImportRecord => ({
  partyId: PARTY,
  documentNumber: 'NF 123',
  description: null,
  issuedOn: '01/09/2026',
  dueOn: '30/10/2026',
  amount: '1.500,75',
  currency: 'brl',
  category: '1.01',
  ...values,
})

async function session(direction: 'receivable' | 'payable' = 'receivable') {
  return new TitleImporter(direction, unused, clock, () => unused).session(context)
}

describe('validating an open title', () => {
  it('reads one installment of what is owed, the file’s way', async () => {
    const titles = await session()
    const valid = titles.validate(row({}))
    expect(valid.isRight() && valid.value).toEqual({
      category: '1.01',
      terms: {
        partyId: PARTY,
        documentNumber: 'NF 123',
        description: undefined,
        currency: 'BRL',
        categoryId: null,
        issuedOn: '2026-09-01',
        installments: [{ dueOn: '2026-10-30', amount: '150075' }],
      },
    })
    expect(valid.isRight() && titles.uniqueKey(valid.value)).toBe(`${PARTY}\u0000NF 123`)
  })

  it('names every field that is wrong', async () => {
    const titles = await session()
    const invalid = titles.validate(
      row({
        partyId: 'Cliente A',
        category: null,
        issuedOn: '31/02/2026',
        dueOn: null,
        currency: 'real',
      }),
    )
    expect(invalid.isLeft() && invalid.value.map((issue) => issue.field)).toEqual([
      'partyId',
      'category',
      'issuedOn',
      'dueOn',
      'currency',
    ])
    const zero = titles.validate(row({ amount: '0,00' }))
    expect(zero.isLeft() && zero.value[0]?.field).toBe('amount')
    const cents = titles.validate(row({ amount: '1,005' }))
    expect(cents.isLeft() && cents.value[0]?.field).toBe('amount')
  })

  it('refuses what the title terms refuse, under the importer’s field names', async () => {
    const titles = await session('payable')
    const blank = titles.validate(row({ documentNumber: null }))
    expect(blank.isLeft() && blank.value[0]?.field).toBe('documentNumber')
    const long = titles.validate(row({ description: 'x'.repeat(501) }))
    expect(long.isLeft() && long.value[0]?.field).toBe('description')
  })

  it('is one kind per direction', () => {
    expect(new TitleImporter('receivable', unused, clock, () => unused).kind).toBe('receivables')
    expect(new TitleImporter('payable', unused, clock, () => unused).kind).toBe('payables')
    expect(minorUnitsOf('10', 'JPY')).toBe('10')
    expect(minorUnitsOf('x', 'BRL')).toBeNull()
  })
})
