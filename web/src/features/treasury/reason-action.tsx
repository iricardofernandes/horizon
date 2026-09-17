'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { apiError } from '@/lib/api'
import { idempotentJsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { TREASURY_API } from './types'

/** Undoing a movement always says why; the reason stays in the journal (ADR 0042). */
export function ReasonAction({
  label,
  name,
  path,
  success,
  onDone,
}: {
  label: string
  name: string
  path: string
  success: string
  onDone: (notice: string) => Promise<void>
}) {
  const t = useTranslations('treasury')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '')
    const response = await tracedFetch(name, `${TREASURY_API}${path}`, {
      method: 'POST',
      headers: idempotentJsonHeaders(),
      body: JSON.stringify({ reason }),
    })
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('actionFailed')))
      return
    }
    setOpen(false)
    await onDone(success)
  }

  if (!open)
    return (
      <Button onClick={() => setOpen(true)} type="button" variant="ghost">
        {label}
      </Button>
    )
  return (
    <form className="receivable-inline-form" onSubmit={submit}>
      <TextField label={t('reason')} maxLength={500} minLength={3} name="reason" required />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <Button onClick={() => setOpen(false)} type="button" variant="secondary">
          {common('cancel')}
        </Button>
        <Button disabled={busy} type="submit" variant="danger">
          {label}
        </Button>
      </div>
    </form>
  )
}
