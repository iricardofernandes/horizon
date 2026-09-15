'use client'

import { usePathname } from 'next/navigation'
import { type ReactNode, useCallback, useState } from 'react'
import { NoticeProvider, SessionProvider } from '@/components/shell/workspace-context'
import { WorkspaceNavigation } from '@/components/shell/workspace-navigation'
import { WorkspaceTopbar } from '@/components/shell/workspace-topbar'
import { LoadingState, Notice } from '@/components/ui/state'
import { entryForPath, isEntryVisible, visibleNavigation } from '@/lib/navigation'
import { useWorkspaceSession } from '@/lib/use-session'

const hostedDemo = process.env.NEXT_PUBLIC_HORIZON_HOSTED_DEMO === 'true'
const demoNotice =
  'Public demo profile: live session and Catalog on Neon. The asynchronous order choreography remains available in the full local stack.'
const unavailableNotice =
  'The workspace could not be loaded. Check that the application services are running.'

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { session, failed } = useWorkspaceSession()
  const [notice, setNotice] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const publish = useCallback((value: string) => setNotice(value), [])
  const toggleSidebar = useCallback(() => setCollapsed((value) => !value), [])

  const workspaceName = session?.workspace?.name ?? 'Workspace'
  const entry = entryForPath(pathname)
  const roles = session?.roles ?? []

  return (
    <SessionProvider value={session}>
      <NoticeProvider value={publish}>
        <div className={collapsed ? 'workspace-shell sidebar-collapsed' : 'workspace-shell'}>
          <aside className="sidebar" id="workspace-sidebar">
            <a
              aria-label={`${workspaceName} workspace`}
              className="workspace-control"
              href="/workspaces"
            >
              <span className="brand-mark">{workspaceName.slice(0, 1).toUpperCase()}</span>
              <span className="workspace-control-copy">
                <strong>{workspaceName}</strong>
                <small>Switch workspace</small>
              </span>
            </a>
            <WorkspaceNavigation groups={visibleNavigation(roles, hostedDemo)} />
          </aside>

          <main className="workspace-main">
            <WorkspaceTopbar
              collapsed={collapsed}
              onToggleSidebar={toggleSidebar}
              session={session}
              title={entry?.label ?? 'Overview'}
              workspaceName={workspaceName}
            />
            <div className="content">
              {hostedDemo ? <Notice copy={demoNotice} /> : null}
              {notice ? <Notice copy={notice} /> : null}
              {failed ? <Notice copy={unavailableNotice} /> : null}
              <ShellContent
                permitted={!entry || isEntryVisible(entry, roles, hostedDemo)}
                ready={Boolean(session)}
                stalled={failed}
              >
                {children}
              </ShellContent>
            </div>
          </main>
        </div>
      </NoticeProvider>
    </SessionProvider>
  )
}

function ShellContent({
  ready,
  stalled,
  permitted,
  children,
}: {
  ready: boolean
  stalled: boolean
  permitted: boolean
  children: ReactNode
}) {
  if (stalled) return null
  if (!ready) return <LoadingState />
  if (!permitted) return <PermissionDenied />
  return <>{children}</>
}

function PermissionDenied() {
  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">Not available</p>
        <h1>You do not have access to this screen</h1>
        <p>Ask a workspace administrator to grant you a role in the module that owns it.</p>
      </header>
    </section>
  )
}
