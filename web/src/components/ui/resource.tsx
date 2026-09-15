'use client'

import type { ReactNode } from 'react'
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
  if (state.loading) return <LoadingState />
  if (state.error) return <Notice copy={state.error} />
  if (!state.data) return null
  return <>{children(state.data)}</>
}
