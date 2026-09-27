'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Plus, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { minorUnits } from '@/lib/format'
import { type CrmDirectory, newKey, send } from './crm-data'
import { accountName, activeStages, type Pipeline, personLabel } from './types'

const NO_SOURCE = 'none'

/** An opportunity opened on an active account, in a stage of this pipeline (Phase 56). */
export function NewOpportunityDialog({
  data,
  pipeline,
  userId,
  onChanged,
}: {
  data: CrmDirectory
  pipeline: Pipeline
  userId: string | null
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const common = useTranslations('common')
  const setNotice = useNotice()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const accounts = data.accounts.filter((row) => row.status === 'active')
  const stages = activeStages(pipeline)
  const owners = data.owners.filter((row) => row.active)
  const sources = data.sources.filter((row) => !row.archived)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const amount = minorUnits(String(form.get('amount') ?? ''))
    if (!amount) {
      setError(t('newOpportunity.invalidAmount'))
      return
    }
    const sourceId = String(form.get('sourceId') ?? NO_SOURCE)
    setBusy(true)
    setError('')
    const result = await send('crm.opportunity.create', 'POST', '/opportunities', {
      key: newKey(),
      fallback: t('newOpportunity.failed'),
      body: {
        accountId: form.get('accountId'),
        ownerId: form.get('ownerId'),
        pipelineId: pipeline.id,
        stageId: form.get('stageId'),
        title: form.get('title'),
        sourceId: sourceId === NO_SOURCE ? null : sourceId,
        expectedValue: { amount, currency: String(form.get('currency') ?? 'BRL') },
        expectedCloseOn: form.get('expectedCloseOn'),
      },
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setOpen(false)
    setNotice(t('newOpportunity.created'))
    await onChanged()
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger
        className="ui-button ui-button-primary"
        disabled={accounts.length === 0 || stages.length === 0}
      >
        <Plus aria-hidden="true" size={17} />
        {t('newOpportunity.open')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <div className="dialog-heading">
            <Dialog.Title>{t('newOpportunity.title')}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('newOpportunity.description', { pipeline: pipeline.name })}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <form className="dialog-form" key={String(open)} onSubmit={submit}>
            <SelectField
              label={t('table.account')}
              name="accountId"
              options={accounts.map((row) => ({
                label: accountName(row, t('unknownAccount')),
                value: row.id,
              }))}
              required
            />
            <TextField
              label={t('table.title')}
              maxLength={160}
              minLength={2}
              name="title"
              required
            />
            <div className="crm-form-row">
              <TextField
                inputMode="decimal"
                label={t('newOpportunity.amount')}
                name="amount"
                placeholder="0.00"
                required
              />
              <TextField
                defaultValue="BRL"
                label={t('newOpportunity.currency')}
                maxLength={3}
                minLength={3}
                name="currency"
                required
              />
              <TextField label={t('table.closeOn')} name="expectedCloseOn" required type="date" />
            </div>
            <div className="crm-form-row">
              <SelectField
                label={t('table.stage')}
                name="stageId"
                options={stages.map((row) => ({
                  label: `${row.name} (${row.probabilityBps / 100}%)`,
                  value: row.id,
                }))}
                required
              />
              <SelectField
                defaultValue={userId && owners.some((row) => row.userId === userId) ? userId : null}
                label={t('table.owner')}
                name="ownerId"
                options={owners.map((row) => ({
                  label: personLabel(data.names, row.userId, t('noOwner')),
                  value: row.userId,
                }))}
                required
              />
              <SelectField
                defaultValue={NO_SOURCE}
                label={t('opportunity.source')}
                name="sourceId"
                options={[
                  { label: t('opportunity.noSource'), value: NO_SOURCE },
                  ...sources.map((row) => ({ label: row.name, value: row.id })),
                ]}
              />
            </div>
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
                {t('newOpportunity.submit')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
