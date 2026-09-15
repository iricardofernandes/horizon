'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { SessionExpiredError } from '@/lib/api'

export type LoaderState<T> = {
  data: T | null
  loading: boolean
  error: string
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
  const [error, setError] = useState('')

  const run = useCallback(async () => {
    try {
      setData(await load())
      setError('')
    } catch (cause) {
      if (cause instanceof SessionExpiredError) {
        router.replace('/login')
        return
      }
      setError('This screen could not be loaded. Check that the application services are running.')
    } finally {
      setLoading(false)
    }
  }, [load, router])

  useEffect(() => {
    void run()
  }, [run])

  return { data, loading, error, reload: run }
}
