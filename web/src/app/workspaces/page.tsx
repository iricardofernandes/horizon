'use client'

import { ArrowRight, DotsThree } from '@phosphor-icons/react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { tracedFetch } from '@/lib/telemetry'

type Workspace = { tenantId: string; slug: string; name: string }

export default function WorkspacesPage() {
  const router = useRouter()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    tracedFetch('session.workspaces', '/api/session/workspace')
      .then(async (response) => {
        if (!response.ok) return router.replace('/login')
        const body = (await response.json()) as { workspaces: Workspace[] }
        setWorkspaces(body.workspaces)
      })
      .catch(() => setError('Your workspaces could not be loaded. Please sign in again.'))
  }, [router])

  async function select(workspace: Workspace) {
    setBusy(workspace.tenantId)
    setError('')
    const response = await tracedFetch('session.workspace.select', '/api/session/workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workspace),
    }).catch(() => null)
    if (!response?.ok) {
      setBusy('')
      setError('This workspace is unavailable. Please sign in again.')
      return
    }
    window.localStorage.setItem('horizon.activeWorkspace', JSON.stringify(workspace))
    window.location.replace('/app')
  }

  async function useAnotherAccount() {
    await tracedFetch('session.logout', '/api/session', { method: 'DELETE' }).catch(() => null)
    window.localStorage.removeItem('horizon.activeWorkspace')
    router.replace('/login')
  }

  return (
    <main className="workspace-picker-shell">
      <section className="workspace-picker-card" aria-labelledby="workspace-title">
        <a className="brand" href="/">
          <span className="brand-mark">H</span>
          <span>Horizon</span>
        </a>
        <header>
          <p className="eyebrow">Choose where to work</p>
          <h1 id="workspace-title">Your workspaces</h1>
          <p className="muted">Your permissions and data are isolated in each workspace.</p>
        </header>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="workspace-options" aria-live="polite">
          {workspaces.length ? (
            workspaces.map((workspace) => (
              <Button
                disabled={Boolean(busy)}
                focusableWhenDisabled
                key={workspace.tenantId}
                onClick={() => select(workspace)}
                type="button"
                variant="workspace"
              >
                <span className="workspace-avatar" aria-hidden="true">
                  {workspace.name.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{workspace.name}</strong>
                  <small>{workspace.slug}</small>
                </span>
                <span className="workspace-arrow" aria-hidden="true">
                  {busy === workspace.tenantId ? (
                    <DotsThree size={20} weight="bold" />
                  ) : (
                    <ArrowRight size={20} />
                  )}
                </span>
              </Button>
            ))
          ) : (
            <p className="muted">Loading workspaces…</p>
          )}
        </div>
        <Button className="workspace-signout" onClick={useAnotherAccount} type="button">
          Use another account
        </Button>
      </section>
    </main>
  )
}
