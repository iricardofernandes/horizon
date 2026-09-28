'use client'

import { startAuthentication } from '@simplewebauthn/browser'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { cleanCode, type SecondFactorMethod } from '@/lib/access'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'

type Props = {
  methods: SecondFactorMethod[]
  onDone: () => void
  onCancel: () => void
}

/** The second step of signing in (Phase 67): an app's code, a recovery code, or a passkey. */
export function SecondFactorStep({ methods, onDone, onCancel }: Props) {
  const t = useTranslations('login.secondFactor')
  const codeMethods = methods.filter(
    (method): method is 'totp' | 'recovery' => method !== 'passkey',
  )
  const [method, setMethod] = useState<'totp' | 'recovery'>(codeMethods[0] ?? 'totp')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function answer(body: unknown) {
    setBusy(true)
    setError('')
    const response = await tracedFetch('session.mfa', '/api/session/mfa', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    }).catch(() => null)
    setBusy(false)
    if (response?.ok) return onDone()
    setError(response?.status === 429 ? t('locked') : t('wrong'))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = String(new FormData(event.currentTarget).get('code') ?? '')
    await answer({ method, code: cleanCode(method, code) })
  }

  async function passkey() {
    setBusy(true)
    setError('')
    try {
      const options = await tracedFetch('session.mfa.passkey-options', '/api/session/mfa', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ method: 'passkey-options' }),
      })
      if (!options.ok) throw new Error('options')
      const response = await startAuthentication({ optionsJSON: await options.json() })
      await answer({ method: 'passkey', response })
    } catch {
      setBusy(false)
      setError(t('passkeyFailed'))
    }
  }

  return (
    <form className="login-card" onSubmit={(event) => void submit(event)}>
      <div>
        <p className="eyebrow">{t('eyebrow')}</p>
        <h2>{t('title')}</h2>
        <p className="muted">{t('copy')}</p>
      </div>
      {codeMethods.length > 1 ? (
        <fieldset className="scope-fieldset">
          <legend>{t('method')}</legend>
          {codeMethods.map((candidate) => (
            <label key={candidate}>
              <input
                checked={method === candidate}
                name="method"
                onChange={() => setMethod(candidate)}
                type="radio"
              />{' '}
              {t(`methods.${candidate}`)}
            </label>
          ))}
        </fieldset>
      ) : null}
      {codeMethods.length > 0 ? (
        <TextField
          autoComplete="one-time-code"
          autoFocus
          inputMode={method === 'totp' ? 'numeric' : 'text'}
          label={t(`labels.${method}`)}
          name="code"
          required
        />
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {codeMethods.length > 0 ? (
        <Button className="wide" disabled={busy} type="submit" variant="primary">
          {t('verify')}
        </Button>
      ) : null}
      {methods.includes('passkey') ? (
        <Button
          className="wide"
          disabled={busy}
          onClick={() => void passkey()}
          type="button"
          variant="secondary"
        >
          {t('usePasskey')}
        </Button>
      ) : null}
      <Button onClick={onCancel} type="button" variant="ghost">
        {t('back')}
      </Button>
    </form>
  )
}
