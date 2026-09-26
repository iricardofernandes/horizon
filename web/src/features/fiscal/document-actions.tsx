'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { type CommandOutcome, fiscalCommand, useFiscalRole } from './client'
import {
  actionBody,
  allowedActions,
  type DocumentAction,
  type DocumentModel,
  type DocumentSummary,
} from './types'

/** The route of each action, per model family. NFS-e commands live under their own path. */
function actionPath(summary: DocumentSummary, action: DocumentAction): string {
  const service = summary.model === 'nfse'
  const base = service ? `/service-documents/${summary.id}` : `/documents/${summary.id}`
  switch (action) {
    case 'validate':
      return `${base}/validate`
    case 'issue':
      return `${base}/issue`
    case 'consult':
      return `${base}/status-queries`
    case 'consultCancellation':
      return `${base}/cancellation-queries`
    case 'cancel':
      return `${base}/cancellation-requests`
    case 'correctionLetter':
      return `${base}/correction-letters`
    case 'substitute':
      return `${base}/substitutions`
  }
}

const IMMEDIATE: readonly DocumentAction[] = ['validate', 'issue', 'consult', 'consultCancellation']

/**
 * The commands a document accepts now. Each posts once with an idempotency key; when
 * Fiscal refuses, its stable code and reason are shown and nothing is assumed.
 */
export function DocumentActions({
  summary,
  status,
  onChanged,
}: {
  summary: DocumentSummary
  status: DocumentSummary['status']
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('fiscal')
  const role = useFiscalRole()
  const [active, setActive] = useState<DocumentAction | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const actions = allowedActions(role, { ...summary, status })

  async function run(action: DocumentAction, body?: unknown) {
    setBusy(true)
    setError('')
    setNotice('')
    const outcome: CommandOutcome = await fiscalCommand(
      `fiscal.document.${action}`,
      actionPath(summary, action),
      body,
    )
    setBusy(false)
    if (!outcome.ok) {
      setError(
        t('actions.refused', {
          code: outcome.code ?? String(outcome.status),
          detail: outcome.detail ?? t('actions.noDetail'),
        }),
      )
      return
    }
    setActive(null)
    setNotice(t(`actions.done.${action}`))
    await onChanged()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!active) return
    const data = new FormData(event.currentTarget)
    void run(
      active,
      actionBody(active, summary.model, (name) => String(data.get(name) ?? '')),
    )
  }

  if (!actions.length) return notice ? <p role="status">{notice}</p> : null
  const form = active && !IMMEDIATE.includes(active) ? active : null
  return (
    <section aria-label={t('actions.title')} className="fiscal-actions">
      <div className="dialog-actions">
        {actions.map((action) => (
          <Button
            disabled={busy}
            key={action}
            onClick={() =>
              IMMEDIATE.includes(action)
                ? void run(action)
                : setActive(active === action ? null : action)
            }
            type="button"
            variant={action === 'cancel' ? 'danger' : 'secondary'}
          >
            {t(`actions.${action}`)}
          </Button>
        ))}
      </div>
      {form ? (
        <form className="dialog-form" onSubmit={submit}>
          <ActionFields action={form} model={summary.model} />
          <div className="dialog-actions">
            <Button
              disabled={busy}
              onClick={() => setActive(null)}
              type="button"
              variant="secondary"
            >
              {t('actions.back')}
            </Button>
            <Button disabled={busy} type="submit" variant="primary">
              {busy ? t('actions.sending') : t(`actions.confirm.${form}`)}
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  )
}

/** The inputs each action with a form needs, and nothing else. */
function ActionFields({ action, model }: { action: DocumentAction; model: DocumentModel }) {
  const t = useTranslations('fiscal')
  const reasonCodes = (values: readonly string[], group: string) => (
    <SelectField
      label={t('actions.reasonCode')}
      name="reasonCode"
      options={values.map((value) => ({ value, label: t(`actions.${group}.${value}`) }))}
    />
  )
  if (action === 'correctionLetter')
    return (
      <>
        <TextField
          label={t('actions.letterText')}
          maxLength={1000}
          minLength={15}
          name="text"
          required
        />
        <label className="fiscal-attestation">
          <input name="attestation" required type="checkbox" />
          {t('actions.attestation')}
        </label>
      </>
    )
  const reason = (
    <TextField
      label={t('actions.reason')}
      maxLength={255}
      minLength={15}
      name="reason"
      required={action === 'cancel'}
    />
  )
  if (action === 'substitute')
    return (
      <>
        {reasonCodes(['01', '02', '03', '04', '05', '99'], 'substitutionReasons')}
        <TextField label={t('actions.correctedOrigin')} name="serviceOriginId" required />
        {reason}
      </>
    )
  return (
    <>
      {model === 'nfse' ? reasonCodes(['1', '2', '9'], 'cancellationReasons') : null}
      {reason}
    </>
  )
}
