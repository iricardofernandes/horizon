'use client'

import { createContext, useContext } from 'react'
import type { RoleAssignment } from '@/lib/navigation'

export type Workspace = { tenantId: string; slug: string; name: string }

export type SessionUser = {
  id: string
  name: string
  email: string
  roles: RoleAssignment[]
  workspace: Workspace | null
}

const SessionContext = createContext<SessionUser | null>(null)
const NoticeContext = createContext<(value: string) => void>(() => undefined)

export const SessionProvider = SessionContext.Provider
export const NoticeProvider = NoticeContext.Provider

/** The signed-in user, or null while the shell is still resolving the session. */
export function useSession(): SessionUser | null {
  return useContext(SessionContext)
}

/** Publishes a message into the shell's notice region. */
export function useNotice(): (value: string) => void {
  return useContext(NoticeContext)
}
