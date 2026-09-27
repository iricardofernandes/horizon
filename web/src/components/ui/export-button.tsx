'use client'

import { DownloadSimple } from '@phosphor-icons/react'
import { useLocale, useTranslations } from 'next-intl'

/**
 * Exports a list as CSV through the web server, with the signed-in user's own access
 * (Phase 63). `path` is the list's API path under the proxy, `query` the list's own filter.
 */
export function ExportButton({ path, query = '' }: { path: string; query?: string }) {
  const t = useTranslations('common')
  const locale = useLocale() === 'en' ? 'en' : 'pt-BR'
  const search = new URLSearchParams(query)
  search.set('locale', locale)
  return (
    <a
      className="ui-button ui-button-secondary"
      download
      href={`/api/export/${path}?${search}`}
      title={t('exportListHint')}
    >
      <DownloadSimple aria-hidden size={16} />
      {t('exportList')}
    </a>
  )
}
