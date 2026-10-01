'use client'

import { Dialog } from '@base-ui/react/dialog'
import { X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { fiscalCommand } from '../client'
import type { ChangeKind } from './types'

/** What the person is asking about: a package, a rule to retire, or nothing yet (a new rule). */
export type RequestTarget =
  | { kind: 'adopt-package' | 'withdraw-package'; packageId: string; label: string }
  | { kind: 'retire-rule'; ruleId: string; label: string }
  | { kind: 'add-rule' }

/** A starting definition the person edits: every field Fiscal reads, with its usual value. */
const RULE_TEMPLATE = {
  ruleKey: 'workspace.',
  version: 1,
  group: 'legacy',
  code: 'ICMS',
  precedence: 'operation',
  priority: 600,
  model: '55',
  environment: 'simulation',
  operation: '',
  effectiveFrom: new Date().toISOString().slice(0, 10),
  rate: { numerator: '18', denominator: '100' },
  formula: 'LINE_NET_TIMES_RATE',
  sourceLocator: '',
}

/**
 * Asks for a rule change (Phase 88, ADR 0074). Fiscal checks it, works out its diff and its
 * impact, and keeps it for someone else to decide.
 */
export function RequestDialog({
  target,
  onClose,
  onRequested,
}: {
  target: RequestTarget
  onClose: () => void
  onRequested: (changeId: string) => Promise<void>
}) {
  const t = useTranslations('fiscal.rules')
  const common = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '').trim()
    const months = Number(text('impactMonths') || '3')
    let body: Record<string, unknown>
    try {
      body = bodyOf(target, text)
    } catch {
      return setError(t('definitionInvalid'))
    }
    setBusy(true)
    setError('')
    const outcome = await fiscalCommand('fiscal.rule-change.request', '/rule-changes', {
      ...body,
      reason: text('reason'),
      impactMonths: months,
    })
    setBusy(false)
    if (!outcome.ok) return setError(outcome.detail ?? t('actionFailed'))
    await onRequested((outcome.body as { id: string }).id)
  }

  return (
    <Dialog.Root onOpenChange={(open) => (open ? undefined : onClose())} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup document-dialog">
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <Dialog.Title>{t(`kinds.${target.kind as ChangeKind}`)}</Dialog.Title>
          {'label' in target ? <p className="document-note">{target.label}</p> : null}
          <form className="dialog-form" onSubmit={(event) => void submit(event)}>
            {target.kind === 'adopt-package' ? (
              <>
                <TextField
                  defaultValue={new Date().toISOString().slice(0, 10)}
                  label={t('effectiveFrom')}
                  name="effectiveFrom"
                  required
                  type="date"
                />
                <TextArea label={t('interpretation')} name="interpretation" rows={3} />
              </>
            ) : null}
            {target.kind === 'add-rule' ? (
              <>
                <TextArea
                  defaultValue={JSON.stringify(RULE_TEMPLATE, null, 2)}
                  description={t('definitionHelp')}
                  label={t('definition')}
                  mono
                  name="definition"
                  rows={14}
                />
                <TextField label={t('sourceUri')} name="sourceUri" required type="url" />
                <TextField label={t('sourceSection')} name="sourceSection" required />
              </>
            ) : null}
            <TextArea label={t('reason')} minLength={10} name="reason" rows={2} />
            <TextField
              defaultValue="3"
              description={t('impactMonthsHelp')}
              label={t('impactMonths')}
              max={12}
              min={1}
              name="impactMonths"
              type="number"
            />
            {error ? <Notice copy={error} /> : null}
            <Button disabled={busy} type="submit">
              {t('submitRequest')}
            </Button>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function bodyOf(target: RequestTarget, text: (name: string) => string): Record<string, unknown> {
  switch (target.kind) {
    case 'adopt-package':
      return {
        kind: target.kind,
        packageId: target.packageId,
        effectiveFrom: text('effectiveFrom'),
        interpretation: text('interpretation'),
      }
    case 'withdraw-package':
      return { kind: target.kind, packageId: target.packageId }
    case 'retire-rule':
      return { kind: target.kind, ruleId: target.ruleId }
    case 'add-rule':
      return {
        kind: target.kind,
        definition: JSON.parse(text('definition')) as Record<string, unknown>,
        sourceBasis: { uri: text('sourceUri'), section: text('sourceSection') },
      }
  }
}

function TextArea({
  label,
  name,
  rows,
  description,
  defaultValue,
  minLength,
  mono = false,
}: {
  label: string
  name: string
  rows: number
  description?: string
  defaultValue?: string
  minLength?: number
  mono?: boolean
}) {
  return (
    <label className="ui-field">
      <span className="ui-field-label">{label}</span>
      <textarea
        className={mono ? 'ui-input rule-definition' : 'ui-input'}
        defaultValue={defaultValue}
        maxLength={mono ? 20_000 : 4000}
        minLength={minLength}
        name={name}
        required
        rows={rows}
      />
      {description ? <span className="ui-field-description">{description}</span> : null}
    </label>
  )
}
