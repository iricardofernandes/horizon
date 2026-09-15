import { cookies, headers } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import {
  defaultLocale,
  isLocale,
  type Locale,
  localeCookie,
  localeFromAcceptLanguage,
} from '@/i18n/locale'

/**
 * Resolution order (ADR 0044): the reader's stored choice, then the browser's
 * preference, then Portuguese. The signed-in user's saved preference joins the front of
 * this list once Identity stores it.
 */
export async function resolveLocale(): Promise<Locale> {
  const chosen = (await cookies()).get(localeCookie)?.value
  if (isLocale(chosen)) return chosen
  return localeFromAcceptLanguage((await headers()).get('accept-language')) ?? defaultLocale
}

/** Named date formats, so a screen never spells out its own `Intl` options. */
const formats = {
  dateTime: {
    short: { day: '2-digit', month: '2-digit', year: 'numeric' },
    long: {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    },
  },
} as const

export default getRequestConfig(async () => {
  const locale = await resolveLocale()
  return {
    locale,
    formats,
    messages: (await import(`../../messages/${locale}.json`)).default,
  }
})
