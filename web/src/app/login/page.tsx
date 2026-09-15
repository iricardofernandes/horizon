'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { tracedFetch } from '@/lib/telemetry'

export default function LoginPage() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const data = new FormData(event.currentTarget)
    const response = await tracedFetch('session.login', '/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantSlug: data.get('tenantSlug'),
        email: data.get('email'),
        password: data.get('password'),
      }),
    }).catch(() => null)
    setBusy(false)
    if (!response?.ok) {
      setError('We could not sign you in. Check the workspace and credentials.')
      return
    }
    router.replace('/app')
  }

  return (
    <main className="login-shell">
      <section className="login-story" aria-label="Product introduction">
        <a className="brand brand-on-dark" href="/">
          <span className="brand-mark">H</span>
          <span>Horizon</span>
        </a>
        <div>
          <p className="eyebrow eyebrow-light">A calmer operating system</p>
          <h1>Know what moved, what sold, and what happens next.</h1>
          <p className="login-lead">
            One workspace for the daily decisions that keep your operation moving.
          </p>
        </div>
        <div className="signal-row">
          <span>Live inventory</span>
          <span>Traceable orders</span>
          <span>Signed events</span>
        </div>
      </section>

      <section className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <div>
            <p className="eyebrow">Welcome back</p>
            <h2>Sign in to your workspace</h2>
            <p className="muted">Use the workspace handle your administrator shared.</p>
          </div>
          <label>
            Workspace
            <input
              name="tenantSlug"
              defaultValue="horizon-demo"
              autoComplete="organization"
              required
            />
          </label>
          <label>
            Email
            <input
              name="email"
              type="email"
              defaultValue="demo@horizon.local"
              autoComplete="email"
              required
            />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="primary-button wide" disabled={busy} type="submit">
            {busy ? 'Signing in…' : 'Continue'}
          </button>
          <p className="demo-note">
            Local demo password: <code>Horizon-demo-2026!</code>
          </p>
        </form>
      </section>
    </main>
  )
}
