'use client'

import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'

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

/**
 * A line the reader should see before the screen. `info` is news; `danger` is something that
 * failed, drawn in the danger tokens, because the accent only ever means an action (ADR 0078).
 */
export function Notice({
  action,
  copy,
  tone = 'info',
}: {
  action?: ReactNode
  copy: string
  tone?: 'info' | 'danger'
}) {
  return (
    <div
      className={tone === 'danger' ? 'notice notice-danger' : 'notice'}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <span>{copy}</span>
      {action}
    </div>
  )
}
