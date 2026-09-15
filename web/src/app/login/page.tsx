'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
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
        email: data.get('email'),
        password: data.get('password'),
      }),
    }).catch(() => null)
    setBusy(false)
    if (!response?.ok) {
      setError('We could not sign you in. Check your email and password.')
      return
    }
    router.replace('/workspaces')
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
          <h1>One account. Every operation in reach.</h1>
          <p className="login-lead">
            Every workspace for the daily decisions that keep your operation moving.
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
            <h2>Sign in to Horizon</h2>
            <p className="muted">Your workspaces will appear after you sign in.</p>
          </div>
          <TextField
            autoComplete="email"
            defaultValue="demo@horizon.local"
            label="Email"
            name="email"
            required
            type="email"
          />
          <TextField
            autoComplete="current-password"
            label="Password"
            name="password"
            required
            type="password"
          />
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            className="wide"
            disabled={busy}
            focusableWhenDisabled
            type="submit"
            variant="primary"
          >
            {busy ? 'Signing in…' : 'Continue'}
          </Button>
          <p className="demo-note">
            Local demo password: <code>Horizon-demo-2026!</code>
          </p>
        </form>
      </section>
    </main>
  )
}
