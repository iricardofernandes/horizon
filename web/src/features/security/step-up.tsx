'use client'

import { Dialog } from '@base-ui/react/dialog'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactNode, useCallback, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { cleanCode, isStepUpRequired, MFA_LOCKED, problemTypeOf } from '@/lib/access'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'

type Pending = { resolve: (proved: boolean) => void }

/**
 * Sensitive actions ask to confirm again (ADR 0061 §4). `run` performs an action; when
 * Identity answers "step-up required", it asks for the password (and a code), steps up, and
 * performs the action once more.
 */
export function useStepUp(): {
  run: (action: () => Promise<Response>) => Promise<Response>
  dialog: ReactNode
} {
  const pending = useRef<Pending | null>(null)
  const [open, setOpen] = useState(false)

  const ask = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        pending.current = { resolve }
        setOpen(true)
      }),
    [],
  )

  const run = useCallback(
    async (action: () => Promise<Response>) => {
      const first = await action()
      if (first.status !== 403) return first
      const body = await first
        .clone()
        .json()
        .catch(() => null)
      if (!isStepUpRequired(first.status, body)) return first
      return (await ask()) ? action() : first
    },
    [ask],
  )

  const finish = (proved: boolean) => {
    setOpen(false)
    pending.current?.resolve(proved)
    pending.current = null
  }

  return { run, dialog: <StepUpDialog onFinish={finish} open={open} /> }
}

function StepUpDialog({ open, onFinish }: { open: boolean; onFinish: (proved: boolean) => void }) {
  const t = useTranslations('security.stepUp')
  const [method, setMethod] = useState<'totp' | 'recovery'>('totp')
  const [needsCode, setNeedsCode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const code = String(data.get('code') ?? '')
    setBusy(true)
    setError('')
    const response = await tracedFetch('session.step-up', '/api/session/step-up', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        password: String(data.get('password') ?? ''),
        ...(code ? { method, code: cleanCode(method, code) } : {}),
      }),
    })
    setBusy(false)
    if (response.ok) {
      setNeedsCode(false)
      onFinish(true)
      return
    }
    const type = problemTypeOf(await response.json().catch(() => null))
    if (isStepUpRequired(response.status, { type })) {
      setNeedsCode(true)
      setError(t('codeNeeded'))
    } else setError(type === MFA_LOCKED ? t('locked') : t('failed'))
  }

  return (
    <Dialog.Root onOpenChange={(value) => (value ? undefined : onFinish(false))} open={open}>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <div className="dialog-heading">
            <Dialog.Title>{t('title')}</Dialog.Title>
            <Dialog.Description className="dialog-description">{t('copy')}</Dialog.Description>
          </div>
          <form className="dialog-form" onSubmit={(event) => void submit(event)}>
            <TextField
              autoComplete="current-password"
              label={t('password')}
              name="password"
              required
              type="password"
            />
            {needsCode ? (
              <>
                <fieldset className="scope-fieldset">
                  <legend>{t('method')}</legend>
                  <label>
                    <input
                      checked={method === 'totp'}
                      name="method"
                      onChange={() => setMethod('totp')}
                      type="radio"
                    />{' '}
                    {t('totp')}
                  </label>
                  <label>
                    <input
                      checked={method === 'recovery'}
                      name="method"
                      onChange={() => setMethod('recovery')}
                      type="radio"
                    />{' '}
                    {t('recovery')}
                  </label>
                </fieldset>
                <TextField
                  autoComplete="one-time-code"
                  inputMode={method === 'totp' ? 'numeric' : 'text'}
                  label={t('code')}
                  name="code"
                  required
                />
              </>
            ) : null}
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <Button disabled={busy} type="submit" variant="primary">
                {t('confirm')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
