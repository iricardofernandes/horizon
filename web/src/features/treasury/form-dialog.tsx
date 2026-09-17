'use client'

import { Dialog } from '@base-ui/react/dialog'
import { X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiError } from '@/lib/api'
import { idempotentJsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { TREASURY_API } from './types'

export type Submission = { name: string; path: string; body: Record<string, unknown> }

/**
 * Every treasury command moves money, so every form posts with an idempotency key and keeps
 * the dialog open with the API's reason when it is refused (ADR 0028).
 */
export function FormDialog({
  trigger,
  title,
  description,
  submitLabel,
  success,
  build,
  onDone,
  children,
  triggerVariant = 'primary',
}: {
  trigger: ReactNode
  title: string
  description: string
  submitLabel: string
  success: string
  build: (form: FormData) => Submission | string
  onDone: (notice: string) => Promise<void>
  children: ReactNode
  triggerVariant?: 'primary' | 'secondary' | 'ghost'
}) {
  const t = useTranslations('treasury')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const submission = build(new FormData(event.currentTarget))
    if (typeof submission === 'string') {
      setError(submission)
      return
    }
    setBusy(true)
    const response = await tracedFetch(submission.name, `${TREASURY_API}${submission.path}`, {
      method: 'POST',
      headers: idempotentJsonHeaders(),
      body: JSON.stringify(submission.body),
    })
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('actionFailed')))
      return
    }
    setOpen(false)
    await onDone(success)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className={`ui-button ui-button-${triggerVariant}`}>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup quote-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Description className="dialog-description">{description}</Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <form className="dialog-form" onSubmit={submit}>
            {children}
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <Dialog.Close className="ui-button ui-button-secondary">
                {common('cancel')}
              </Dialog.Close>
              <Button disabled={busy} type="submit" variant="primary">
                {busy ? t('saving') : submitLabel}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
