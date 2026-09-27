'use client'

import { useEffect, useState } from 'react'

/**
 * A query parameter of the current URL, read once the page is in the browser, so a link
 * can open a record on another screen (Phase 53). Null until then, and when absent: the
 * server render and the first client render agree.
 */
export function useUrlParam(name: string): string | null {
  const [value, setValue] = useState<string | null>(null)
  useEffect(() => {
    setValue(new URLSearchParams(window.location.search).get(name))
  }, [name])
  return value
}
