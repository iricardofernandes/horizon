import { expect, it } from 'vitest'
import { jurisdictionOfAddress, UF_IBGE_CODES, ufCodeOf, ufOfCode } from './jurisdiction'
import {
  authorizerForUf,
  authorizerOfEndpoints,
  homologationAdapterVersion,
  SEFAZ_HOMOLOGATION_ENDPOINTS,
} from './sefaz-authorizers'

it('maps every UF to the authorizer in the official relation', () => {
  const byAuthorizer = new Map<string, string[]>()
  for (const uf of Object.keys(UF_IBGE_CODES) as (keyof typeof UF_IBGE_CODES)[]) {
    const authorizer = authorizerForUf(uf)
    byAuthorizer.set(authorizer, [...(byAuthorizer.get(authorizer) ?? []), uf])
  }
  expect(byAuthorizer.get('SVAN')).toEqual(['MA'])
  expect(byAuthorizer.get('SVRS')?.sort()).toEqual([
    'AC',
    'AL',
    'AP',
    'CE',
    'DF',
    'ES',
    'PA',
    'PB',
    'PI',
    'RJ',
    'RN',
    'RO',
    'RR',
    'SC',
    'SE',
    'TO',
  ])
  for (const own of ['AM', 'BA', 'GO', 'MG', 'MS', 'MT', 'PE', 'PR', 'RS', 'SP'])
    expect(byAuthorizer.get(own)).toEqual([own])
  expect(Object.keys(UF_IBGE_CODES)).toHaveLength(27)
})

it('derives the UF from the registered municipality and refuses a mismatch', () => {
  expect(jurisdictionOfAddress({ state: 'MG', municipalityCode: '3106200' })).toEqual({
    uf: 'MG',
    ufCode: '31',
    municipalityCode: '3106200',
  })
  expect(jurisdictionOfAddress({ state: 'SP', municipalityCode: '3106200' })).toBeNull()
  expect(jurisdictionOfAddress({ state: 'SP', municipalityCode: null })).toBeNull()
  expect(jurisdictionOfAddress({ state: 'XX', municipalityCode: '3550308' })).toBeNull()
  expect(jurisdictionOfAddress({ state: 'SP', municipalityCode: '355030' })).toBeNull()
  expect(ufCodeOf('RJ')).toBe('33')
  expect(ufOfCode('53')).toBe('DF')
  expect(() => ufOfCode('99')).toThrow('Unknown')
})

it('identifies an authorizer only by its complete published endpoint set', () => {
  expect(authorizerOfEndpoints(SEFAZ_HOMOLOGATION_ENDPOINTS.SVRS)).toBe('SVRS')
  expect(authorizerOfEndpoints(SEFAZ_HOMOLOGATION_ENDPOINTS.SP)).toBe('SP')
  expect(() =>
    authorizerOfEndpoints({
      ...SEFAZ_HOMOLOGATION_ENDPOINTS.SP,
      event: SEFAZ_HOMOLOGATION_ENDPOINTS.SVRS.event,
    }),
  ).toThrow('Unapproved')
  expect(() =>
    authorizerOfEndpoints({
      ...SEFAZ_HOMOLOGATION_ENDPOINTS.PR,
      status: `${SEFAZ_HOMOLOGATION_ENDPOINTS.PR.status}?wsdl`,
    }),
  ).toThrow('Unapproved')
  for (const set of Object.values(SEFAZ_HOMOLOGATION_ENDPOINTS))
    for (const url of Object.values(set)) expect(new URL(url).protocol).toBe('https:')
  expect(homologationAdapterVersion('SP')).toBe('nfe55-sp-homologation-v1')
  expect(homologationAdapterVersion('SVRS')).toBe('nfe55-svrs-homologation-v1')
})
