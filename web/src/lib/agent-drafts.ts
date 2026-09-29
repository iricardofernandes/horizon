'use client'

import { useEffect, useState } from 'react'
import { tracedFetch } from '@/lib/telemetry'

/**
 * Which records a workspace's agents drafted (ADR 0066), as the agent's own log says. The
 * lists mark them and can show them alone. It never breaks a list: a person without the
 * module's role, or an agent service that does not answer, simply marks nothing.
 */
export type DraftModule = 'sales' | 'procurement' | 'financial' | 'crm'

export function draftIdsOf(body: unknown): Set<string> {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return new Set()
  return new Set(
    data
      .map((entry) => (entry as { recordId?: unknown }).recordId)
      .filter((id): id is string => typeof id === 'string'),
  )
}

/** The rows to show: all of them, or only those an agent drafted. */
export function withDrafts<T>(
  rows: readonly T[],
  ids: ReadonlySet<string>,
  idsOf: (row: T) => readonly string[],
  only: boolean,
): T[] {
  return only ? rows.filter((row) => idsOf(row).some((id) => ids.has(id))) : [...rows]
}

export function useAgentDrafts(module: DraftModule | null, type: string) {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set())
  const [only, setOnly] = useState(false)
  useEffect(() => {
    if (!module) return
    let cancelled = false
    tracedFetch(
      'agent.drafts',
      `/api/horizon/agent/drafts?module=${module}&type=${encodeURIComponent(type)}`,
      { cache: 'no-store' },
    )
      .then(async (response) =>
        response.ok ? draftIdsOf(await response.json()) : new Set<string>(),
      )
      .catch(() => new Set<string>())
      .then((found) => {
        if (!cancelled) setIds(found)
      })
    return () => {
      cancelled = true
    }
  }, [module, type])
  return { ids, only, setOnly }
}
