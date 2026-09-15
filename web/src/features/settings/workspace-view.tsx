'use client'

import { PageHeading } from '@/components/ui/headings'

type SessionUser = { id: string; name: string; email: string }

export function WorkspaceView({
  user,
  workspaceName,
}: {
  user: SessionUser | null
  workspaceName: string
}) {
  return (
    <section>
      <PageHeading
        eyebrow="Workspace administration"
        title="Workspace"
        copy="The company context every document, permission and report belongs to."
      />
      <div className="settings-layout">
        <section className="panel workspace-settings-card">
          <header>
            <div className="brand-mark">{workspaceName.slice(0, 1).toUpperCase()}</div>
            <div>
              <h2>{workspaceName}</h2>
              <p className="settings-card-caption">Current workspace</p>
            </div>
          </header>
          <dl>
            <div>
              <dt>Signed in as</dt>
              <dd>{user?.name ?? '—'}</dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>{user?.email ?? '—'}</dd>
            </div>
          </dl>
          <a className="ui-button ui-button-secondary settings-link" href="/workspaces">
            Switch workspace
          </a>
        </section>
      </div>
    </section>
  )
}
