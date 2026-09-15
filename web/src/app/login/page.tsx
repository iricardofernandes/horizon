'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { tracedFetch } from '@/lib/telemetry'

export default function LoginPage() {
  const t = useTranslations('login')
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
      setError(t('error'))
      return
    }
    router.replace('/workspaces')
  }

  return (
    <main className="login-shell">
      <section className="login-story" aria-label={t('intro')}>
        <a className="brand brand-on-dark" href="/">
          <span className="brand-mark">H</span>
          <span>Horizon</span>
        </a>
        <div>
          <p className="eyebrow eyebrow-light">{t('eyebrow')}</p>
          <h1>{t('headline')}</h1>
          <p className="login-lead">{t('lead')}</p>
        </div>
        <div className="signal-row">
          <span>{t('signalInventory')}</span>
          <span>{t('signalOrders')}</span>
          <span>{t('signalEvents')}</span>
        </div>
      </section>

      <section className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <div>
            <p className="eyebrow">{t('welcome')}</p>
            <h2>{t('title')}</h2>
            <p className="muted">{t('subtitle')}</p>
          </div>
          <TextField
            autoComplete="email"
            defaultValue="demo@horizon.local"
            label={t('email')}
            name="email"
            required
            type="email"
          />
          <TextField
            autoComplete="current-password"
            label={t('password')}
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
            {busy ? t('submitting') : t('submit')}
          </Button>
          <p className="demo-note">
            {t('demoNote')} <code>Horizon-demo-2026!</code>
          </p>
        </form>
      </section>
    </main>
  )
}
