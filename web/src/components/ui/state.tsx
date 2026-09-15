'use client'

import { useTranslations } from 'next-intl'

export function Empty({ copy }: { copy: string }) {
  return <p className="empty">{copy}</p>
}

export function LoadingState({ copy }: { copy?: string }) {
  const t = useTranslations('common')
  return (
    <div className="loading" aria-live="polite">
      <span className="loading-mark">H</span>
      <p>{copy ?? t('loading')}</p>
    </div>
  )
}

export function Notice({ copy }: { copy: string }) {
  return (
    <div className="notice" role="status">
      {copy}
    </div>
  )
}
