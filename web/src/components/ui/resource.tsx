'use client'

import { useTranslations } from 'next-intl'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { LoadingState, Notice } from '@/components/ui/state'
import type { LoaderState } from '@/lib/use-loader'

/** One place where every screen's loading and error states are rendered. */
export function Resource<T>({
  state,
  children,
}: {
  state: LoaderState<T>
  children: (data: T) => ReactNode
}) {
  const t = useTranslations('common')
  const [retrying, setRetrying] = useState(false)

  async function retry() {
    setRetrying(true)
    await state.reload()
    setRetrying(false)
  }

  if (state.loading) return <LoadingState />
  if (state.failed) {
    return (
      <Notice
        action={
          <Button disabled={retrying} focusableWhenDisabled onClick={() => void retry()}>
            {t('retry')}
          </Button>
        }
        copy={t('screenUnavailable')}
        tone="danger"
      />
    )
  }
  if (!state.data) return null
  return <>{children(state.data)}</>
}
