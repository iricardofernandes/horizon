/**
 * Locale is a property of the person reading, not of the workspace (ADR 0044).
 * Authenticated URLs stay language-neutral, so the choice travels in a cookie.
 */
export const locales = ['pt-BR', 'en'] as const

export type Locale = (typeof locales)[number]

export const defaultLocale: Locale = 'pt-BR'

export const localeCookie = 'horizon_locale'

export const localeNames: Record<Locale, string> = {
  'pt-BR': 'Português (Brasil)',
  en: 'English',
}

export function isLocale(value: string | undefined): value is Locale {
  return locales.includes(value as Locale)
}

/** The first locale the browser asks for that this product actually speaks. */
export function localeFromAcceptLanguage(header: string | null): Locale | undefined {
  if (!header) return undefined
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim()
    if (!tag) continue
    if (isLocale(tag)) return tag
    const language = tag.split('-')[0]?.toLowerCase()
    if (language === 'pt') return 'pt-BR'
    if (language === 'en') return 'en'
  }
  return undefined
}
