import { describe, expect, it } from 'vitest'
import { localeFromAcceptLanguage, locales } from '@/i18n/locale'
import en from '../../messages/en.json'
import ptBR from '../../messages/pt-BR.json'

type Catalogue = Record<string, unknown>

function keysOf(value: Catalogue, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === 'object' && entry !== null
      ? keysOf(entry as Catalogue, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  )
}

describe('message catalogues', () => {
  it('declares every locale the product claims to speak', () => {
    expect([...locales].sort()).toEqual(['en', 'pt-BR'])
  })

  it('carries the same keys in every locale', () => {
    const english = keysOf(en).sort()
    const portuguese = keysOf(ptBR).sort()
    expect(portuguese).toEqual(english)
  })

  it('has no empty translation', () => {
    for (const catalogue of [en, ptBR])
      for (const [key, value] of Object.entries(flatten(catalogue))) expect(value, key).not.toBe('')
  })

  it('keeps the same placeholders in both locales', () => {
    const english = flatten(en)
    const portuguese = flatten(ptBR)
    for (const [key, value] of Object.entries(english))
      expect(placeholders(portuguese[key] ?? ''), key).toEqual(placeholders(value))
  })
})

describe('locale negotiation', () => {
  it('prefers an exact match', () => {
    expect(localeFromAcceptLanguage('en-GB,en;q=0.9')).toBe('en')
  })

  it('maps any Portuguese variant to pt-BR', () => {
    expect(localeFromAcceptLanguage('pt-PT,pt;q=0.8')).toBe('pt-BR')
  })

  it('returns nothing for a language the product does not speak', () => {
    expect(localeFromAcceptLanguage('ja,ko;q=0.7')).toBeUndefined()
  })

  it('returns nothing when the header is absent', () => {
    expect(localeFromAcceptLanguage(null)).toBeUndefined()
  })
})

function flatten(value: Catalogue, prefix = ''): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'object' && entry !== null)
      Object.assign(flat, flatten(entry as Catalogue, `${prefix}${key}.`))
    else flat[`${prefix}${key}`] = String(entry)
  }
  return flat
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort()
}
