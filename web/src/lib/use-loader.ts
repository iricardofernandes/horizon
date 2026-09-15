'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { SessionExpiredError } from '@/lib/api'

export type LoaderState<T> = {
  data: T | null
  loading: boolean
  /** True when the screen's data could not be read; the message belongs to the view. */
  failed: boolean
  reload: () => Promise<void>
}

/**
 * Loads one screen's data. `load` must be stable — declare it at module scope, not
 * inside the component — so the screen does not refetch on every render.
 */
export function useLoader<T>(load: () => Promise<T>): LoaderState<T> {
  const router = useRouter()
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const run = useCallback(async () => {
    try {
      setData(await load())
      setFailed(false)
    } catch (cause) {
      if (cause instanceof SessionExpiredError) {
        router.replace('/login')
        return
      }
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [load, router])

  useEffect(() => {
    void run()
  }, [run])

  return { data, loading, failed, reload: run }
}
