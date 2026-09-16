'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Plus, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { apiError } from '@/lib/api'
import { minorUnits } from '@/lib/format'
import { idempotentJsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import type { MutationProps } from './receivables-view'
import { localToday, type ReceivablesData, scheduleOf } from './types'

const SINGLE = 'single'
const NO_CATEGORY = 'none'

/** A new receivable starts as a draft; it becomes a claim only when someone posts it. */
export function CreateReceivableDialog({
  data,
  onChanged,
  setNotice,
}: { data: ReceivablesData } & MutationProps) {
  const t = useTranslations('receivables')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const today = localToday()
  const customers = data.customers.map((customer) => ({
    value: customer.partyId,
    label: customer.legalName,
  }))
  const categories = data.categories
    .filter((category) => category.active && category.nature === 'revenue')
    .map((category) => ({ value: category.id, label: `${category.code} · ${category.name}` }))
  const terms = [
    { value: SINGLE, label: t('singleInstallment') },
    ...data.paymentTerms
      .filter((term) => term.active)
      .map((term) => ({ value: term.id, label: term.name })),
  ]

  function build(form: FormData): Record<string, unknown> | string {
    const total = minorUnits(String(form.get('total') ?? ''))
    if (!total || total === '0') return t('invalidAmount')
    const issuedOn = String(form.get('issuedOn') ?? '')
    const termId = String(form.get('paymentTermId') ?? SINGLE)
    const term = data.paymentTerms.find((candidate) => candidate.id === termId)
    const installments = term
      ? scheduleOf(BigInt(total), issuedOn, term)
      : [{ dueOn: String(form.get('dueOn') ?? ''), amount: total }]
    if (installments.some((installment) => installment.amount === '0'))
      return t('amountTooSmallForTerm')
    return {
      partyId: String(form.get('partyId') ?? ''),
      documentNumber: String(form.get('documentNumber') ?? ''),
      description: String(form.get('description') ?? ''),
      currency: 'BRL',
      categoryId: categoryOf(String(form.get('categoryId') ?? NO_CATEGORY)),
      issuedOn,
      installments,
    }
  }

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
      'financial.receivable.draft',
      '/api/horizon/financial/receivables',
      {
        method: 'POST',
        headers: idempotentJsonHeaders(),
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

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary">
        <Plus aria-hidden="true" size={17} weight="bold" />
        {t('create')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup quote-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{t('createTitle')}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('createDescription')}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {customers.length ? (
            <form className="dialog-form" onSubmit={submit}>
              <SelectField label={t('customer')} name="partyId" options={customers} required />
              <div className="form-grid two-columns">
                <TextField label={t('document')} maxLength={40} name="documentNumber" required />
                <SelectField
                  defaultValue={categories[0]?.value ?? NO_CATEGORY}
                  label={t('category')}
                  name="categoryId"
                  options={[...categories, { value: NO_CATEGORY, label: t('noCategory') }]}
                />
              </div>
              <div className="form-grid two-columns">
                <TextField
                  inputMode="decimal"
                  label={t('amount')}
                  name="total"
                  pattern="[0-9]+([.,][0-9]{1,2})?"
                  placeholder="0.00"
                  required
                />
                <TextField
                  defaultValue={today}
                  label={t('issuedOn')}
                  name="issuedOn"
                  required
                  type="date"
                />
              </div>
              <div className="form-grid two-columns">
                <SelectField label={t('paymentTerm')} name="paymentTermId" options={terms} />
                <TextField
                  defaultValue={today}
                  description={t('dueOnHelp')}
                  label={t('dueOn')}
                  name="dueOn"
                  type="date"
                />
              </div>
              <TextField label={t('description')} maxLength={500} name="description" />
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
                  {busy ? t('saving') : t('saveDraft')}
                </Button>
              </div>
            </form>
          ) : (
            <p className="catalog-page-copy">{t('noCustomers')}</p>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function categoryOf(value: string): string | null {
  return value === NO_CATEGORY ? null : value
}
