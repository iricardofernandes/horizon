'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { SessionUser, Workspace } from '@/components/shell/workspace-context'
import { readJson, SessionExpiredError } from '@/lib/api'
import { tracedFetch } from '@/lib/telemetry'

export type SessionState = { session: SessionUser | null; failed: boolean }

/** Resolves the signed-in user once, sending an expired session back to login. */
export function useWorkspaceSession(): SessionState {
  const router = useRouter()
  const [session, setSession] = useState<SessionUser | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    readJson<SessionUser>('workspace.session', '/api/session')
      .then(withWorkspace)
      .then((user) => {
        if (!cancelled) setSession(user)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        if (cause instanceof SessionExpiredError) router.replace('/login')
        else setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [router])

  return { session, failed }
}

/** The workspace cookie can lag the session; fall back to the last selected workspace. */
async function withWorkspace(user: SessionUser): Promise<SessionUser> {
  if (user.workspace) return user
  const refreshed = await tracedFetch('workspace.session.refresh', '/api/session', {
    cache: 'no-store',
  })
  if (refreshed.ok) {
    const value = (await refreshed.json()) as SessionUser
    if (value.workspace) return value
  }
  const workspace = locallyStoredWorkspace()
  return workspace ? { ...user, workspace } : user
}

function locallyStoredWorkspace(): Workspace | null {
  const value = window.localStorage.getItem('horizon.activeWorkspace')
  if (!value) return null
  try {
    const workspace = JSON.parse(value) as Workspace | null
    return workspace?.tenantId && workspace.slug && workspace.name ? workspace : null
  } catch {
    return null
  }
}
