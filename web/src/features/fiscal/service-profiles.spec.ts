import { describe, expect, it } from 'vitest'
import { localToday, profileOn, profileRequest, type ServiceProfile } from './service-profiles'

const revision = (number: number, effectiveFrom: string): ServiceProfile => ({
  itemId: 'item',
  revision: number,
  nationalTaxCode: '010101',
  nbsCode: '115022000',
  municipalTaxCode: null,
  issTaxation: '1',
  description: 'Desenvolvimento de software',
  effectiveFrom,
  digest: 'a'.repeat(64),
  createdBy: 'user:reviewer',
  createdAt: '2026-09-01T00:00:00.000Z',
})

describe('service profile in force', () => {
  it('reads the latest effective revision and keeps a future one apart', () => {
    const revisions = [
      revision(1, '2026-01-01'),
      revision(2, '2026-06-01'),
      revision(3, '2026-12-01'),
    ]
    const { current, upcoming } = profileOn(revisions, '2026-09-26')
    expect(current?.revision).toBe(2)
    expect(upcoming?.revision).toBe(3)
  })

  it('has no current profile before the first effective date', () => {
    expect(profileOn([revision(1, '2027-01-01')], '2026-09-26')).toMatchObject({
      current: null,
      upcoming: { revision: 1 },
    })
    expect(profileOn([], '2026-09-26')).toEqual({ current: null, upcoming: null })
  })
})

describe('new profile revision', () => {
  const form = {
    itemId: 'item',
    nationalTaxCode: '01.01.01',
    nbsCode: '1.1502.20.00',
    municipalTaxCode: ' ',
    description: ' Desenvolvimento de software sob medida ',
    effectiveFrom: '2026-10-01',
    reason: 'Classificação revisada pelo contador',
  }

  it('accepts codes typed with punctuation and sends digits only', () => {
    const built = profileRequest(form)
    if (!built.ok) throw new Error(built.problem)
    expect(built.body).toEqual({
      itemId: 'item',
      nationalTaxCode: '010101',
      nbsCode: '115022000',
      issTaxation: '1',
      description: 'Desenvolvimento de software sob medida',
      effectiveFrom: '2026-10-01',
      reason: 'Classificação revisada pelo contador',
    })
  })

  it('names the first malformed field', () => {
    expect(profileRequest({ ...form, nationalTaxCode: '0101' })).toEqual({
      ok: false,
      problem: 'nationalTaxCodeInvalid',
    })
    expect(profileRequest({ ...form, nbsCode: '11502' })).toEqual({
      ok: false,
      problem: 'nbsCodeInvalid',
    })
    expect(profileRequest({ ...form, reason: 'curto' })).toEqual({
      ok: false,
      problem: 'reasonTooShort',
    })
    expect(profileRequest({ ...form, description: '  ' })).toEqual({
      ok: false,
      problem: 'descriptionRequired',
    })
  })
})

describe('local day', () => {
  it('reads the calendar day of the given instant in local time', () => {
    expect(localToday(new Date(2026, 8, 26, 23, 59))).toBe('2026-09-26')
    expect(localToday(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05')
  })
})
