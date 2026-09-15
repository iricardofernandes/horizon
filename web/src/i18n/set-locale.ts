'use server'

import { cookies } from 'next/headers'
import { isLocale, localeCookie } from '@/i18n/locale'

/** Stores the reader's language choice without touching the current URL. */
export async function setLocale(value: string): Promise<void> {
  if (!isLocale(value)) return
  ;(await cookies()).set(localeCookie, value, {
    path: '/',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  })
}
