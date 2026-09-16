'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Plus, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactNode, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { apiError } from '@/lib/api'
import { jsonHeaders } from '@/lib/http'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import type { Registry } from './types'

export type MutationProps = { onChanged: () => Promise<void>; setNotice: (value: string) => void }

/** A create dialog whose form body varies by registry; posting and errors do not. */
export function CreateDialog({
  registry,
  trigger,
  title,
  description,
  build,
  children,
  canManage,
  onChanged,
  setNotice,
}: {
  registry: Registry
  trigger: string
  title: string
  description: string
  /** Turns the form into a request body, or returns a validation message. */
  build: (data: FormData) => Record<string, unknown> | string
  children: ReactNode
  canManage: boolean
} & MutationProps) {
  const t = useTranslations('classifications')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const body = build(new FormData(event.currentTarget))
    if (typeof body === 'string') {
      setError(body)
      return
    }
    setBusy(true)
    const response = await tracedFetch(
      `financial.${registry}.define`,
      `/api/horizon/financial/${registry}`,
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      },
    )
    if (!response.ok) {
      setError(await apiError(response, t('createFailed')))
      setBusy(false)
      return
    }
    setOpen(false)
    setNotice(t('created'))
    await onChanged()
    setBusy(false)
  }

  if (!canManage) return null
  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary">
        <Plus aria-hidden="true" size={17} weight="bold" />
        {trigger}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
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
                {busy ? t('saving') : t('save')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Status badge plus, for someone who may configure, the switch that flips it. */
export function StatusCell({
  registry,
  id,
  active,
  label,
  canManage,
  onChanged,
  setNotice,
}: {
  registry: Registry
  id: string
  active: boolean
  label: string
  canManage: boolean
} & MutationProps) {
  const t = useTranslations('classifications')
  const statusLabel = useStatusLabel()
  const [busy, setBusy] = useState(false)
  const status = active ? 'active' : 'inactive'

  async function toggle() {
    setBusy(true)
    const response = await tracedFetch(
      `financial.${registry}.status`,
      `/api/horizon/financial/${registry}/${id}/status`,
      {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ active: !active }),
      },
    )
    setNotice(
      response.ok
        ? t(active ? 'deactivated' : 'activated', { name: label })
        : await apiError(response, t('statusFailed')),
    )
    if (response.ok) await onChanged()
    setBusy(false)
  }

  return (
    <div className="row-actions">
      <Badge status={status} label={statusLabel(status)} />
      {canManage ? (
        <Button disabled={busy} onClick={toggle} type="button">
          {active ? t('deactivate') : t('activate')}
        </Button>
      ) : null}
    </div>
  )
}

export function EmptyRow({ copy, columns }: { copy: string; columns: number }) {
  return (
    <tr>
      <td className="empty" colSpan={columns}>
        {copy}
      </td>
    </tr>
  )
}
