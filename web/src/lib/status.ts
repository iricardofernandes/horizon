'use client'

import { useTranslations } from 'next-intl'

/**
 * Enum values stay English on the wire and are translated here, at the view
 * boundary (ADR 0044). An unknown status renders as sent, rather than as a missing key.
 */
export function useStatusLabel(): (status: string) => string {
  const t = useTranslations('status')
  return (status: string) => (t.has(status) ? t(status) : status.replace('-', ' '))
}
