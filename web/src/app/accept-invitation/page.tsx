'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { invitationTokenOf } from '@/lib/access'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'

type Lookup = { workspace: string; email: string; name: string; hasAccount: boolean }
type State = 'loading' | 'ready' | 'unusable' | 'accepted'

/**
 * An invitation link (Phase 67): who invited you to which workspace, and the password you
 * choose, or the one of the Horizon account you already have. The link works once.
 */
export default function AcceptInvitationPage() {
  const t = useTranslations('invitation')
  const [token, setToken] = useState<string | null>(null)
  const [lookup, setLookup] = useState<Lookup | null>(null)
  const [state, setState] = useState<State>('loading')

  useEffect(() => {
    const found = invitationTokenOf(window.location.search)
    setToken(found)
    if (!found) return setState('unusable')
    tracedFetch('invitation.lookup', `/api/invitation?token=${found}`)
      .then(async (response) => {
        if (!response.ok) return setState('unusable')
        setLookup((await response.json()) as Lookup)
        setState('ready')
      })
      .catch(() => setState('unusable'))
  }, [])

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-card">
          <p className="eyebrow">{t('eyebrow')}</p>
          {state === 'loading' ? <p>{t('loading')}</p> : null}
          {state === 'unusable' ? <Unusable /> : null}
          {state === 'accepted' ? <Accepted workspace={lookup?.workspace ?? ''} /> : null}
          {state === 'ready' && lookup && token ? (
            <AcceptForm lookup={lookup} onState={setState} token={token} />
          ) : null}
        </div>
      </section>
    </main>
  )
}

function Unusable() {
  const t = useTranslations('invitation')
  return (
    <>
      <h2>{t('unusableTitle')}</h2>
      <p className="muted">{t('unusableCopy')}</p>
    </>
  )
}

function Accepted({ workspace }: { workspace: string }) {
  const t = useTranslations('invitation')
  const router = useRouter()
  return (
    <>
      <h2>{t('acceptedTitle')}</h2>
      <p className="muted">{t('acceptedCopy', { workspace })}</p>
      <Button
        className="wide"
        onClick={() => router.replace('/login')}
        type="button"
        variant="primary"
      >
        {t('signIn')}
      </Button>
    </>
  )
}

function AcceptForm({
  lookup,
  token,
  onState,
}: {
  lookup: Lookup
  token: string
  onState: (state: State) => void
}) {
  const t = useTranslations('invitation')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    if (!lookup.hasAccount && data.get('password') !== data.get('confirm')) {
      setError(t('mismatch'))
      return
    }
    setBusy(true)
    setError('')
    const response = await tracedFetch('invitation.accept', '/api/invitation', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        token,
        name: String(data.get('name') ?? ''),
        password: String(data.get('password') ?? ''),
      }),
    })
    setBusy(false)
    if (response.ok) onState('accepted')
    else if (response.status === 410) onState('unusable')
    else setError(response.status === 401 ? t('wrongPassword') : t('failed'))
  }

  return (
    <form className="dialog-form" onSubmit={(event) => void submit(event)}>
      <h2>{t('title', { workspace: lookup.workspace })}</h2>
      <p className="muted">
        {lookup.hasAccount
          ? t('existingCopy', { email: lookup.email })
          : t('newCopy', { email: lookup.email })}
      </p>
      <TextField defaultValue={lookup.name} label={t('name')} name="name" required />
      <TextField
        autoComplete={lookup.hasAccount ? 'current-password' : 'new-password'}
        label={lookup.hasAccount ? t('currentPassword') : t('newPassword')}
        minLength={12}
        name="password"
        required
        type="password"
      />
      {lookup.hasAccount ? null : (
        <TextField
          autoComplete="new-password"
          label={t('confirmPassword')}
          minLength={12}
          name="confirm"
          required
          type="password"
        />
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button className="wide" disabled={busy} type="submit" variant="primary">
        {t('accept')}
      </Button>
    </form>
  )
}
