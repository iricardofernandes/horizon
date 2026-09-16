'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import type { Category, PaymentMethod } from '@/features/classifications/types'
import { minorUnits } from '@/lib/format'
import { decimalOf, type Installment, localToday, type ReceivableDetail } from './types'

const NO_METHOD = 'none'

/** Reversals and cancellations always say why; the reason stays in the record (ADR 0042). */
export function ReasonForm({
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  busy: boolean
  submitLabel: string
  onSubmit: (reason: string) => Promise<void>
  onCancel: () => void
}) {
  const t = useTranslations('receivables')
  const common = useTranslations('common')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await onSubmit(String(new FormData(event.currentTarget).get('reason') ?? ''))
  }
  return (
    <form className="receivable-inline-form" onSubmit={submit}>
      <TextField label={t('reason')} maxLength={500} minLength={3} name="reason" required />
      <div className="dialog-actions">
        <Button onClick={onCancel} type="button" variant="secondary">
          {common('cancel')}
        </Button>
        <Button disabled={busy} type="submit" variant="danger">
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

export function SettleForm({
  installment,
  issuedOn,
  paymentMethods,
  busy,
  onSubmit,
  onCancel,
}: {
  installment: Installment
  issuedOn: string
  paymentMethods: PaymentMethod[]
  busy: boolean
  onSubmit: (body: Record<string, unknown>) => Promise<void>
  onCancel: () => void
}) {
  const t = useTranslations('receivables')
  const common = useTranslations('common')
  const [error, setError] = useState('')
  const today = localToday()
  const methods = [
    ...paymentMethods
      .filter((method) => method.active)
      .map((method) => ({ value: method.id, label: method.name })),
    { value: NO_METHOD, label: t('noPaymentMethod') },
  ]

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const form = new FormData(event.currentTarget)
    const amounts = Object.fromEntries(
      ['received', 'discount', 'interest', 'penalty'].map((field) => [
        field,
        minorUnits(String(form.get(field) ?? '') || '0'),
      ]),
    )
    if (Object.values(amounts).some((amount) => amount === null)) {
      setError(t('invalidAmount'))
      return
    }
    const method = String(form.get('paymentMethodId') ?? NO_METHOD)
    await onSubmit({
      installmentNumber: installment.number,
      settledOn: String(form.get('settledOn') ?? today),
      ...amounts,
      paymentMethodId: method === NO_METHOD ? null : method,
    })
  }

  return (
    <form className="receivable-inline-form" onSubmit={submit}>
      <strong>{t('settleTitle', { number: installment.number })}</strong>
      <div className="form-grid two-columns">
        <TextField
          defaultValue={today < issuedOn ? issuedOn : today}
          label={t('settledOn')}
          min={issuedOn}
          name="settledOn"
          required
          type="date"
        />
        <SelectField label={t('paymentMethod')} name="paymentMethodId" options={methods} />
      </div>
      <div className="form-grid four-columns">
        <AmountField
          defaultValue={decimalOf(installment.outstanding)}
          label={t('received')}
          name="received"
        />
        <AmountField label={t('discount')} name="discount" />
        <AmountField label={t('interest')} name="interest" />
        <AmountField label={t('penalty')} name="penalty" />
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <Button onClick={onCancel} type="button" variant="secondary">
          {common('cancel')}
        </Button>
        <Button disabled={busy} type="submit" variant="primary">
          {t('recordSettlement')}
        </Button>
      </div>
    </form>
  )
}

function AmountField({
  label,
  name,
  defaultValue = '',
}: {
  label: string
  name: string
  defaultValue?: string
}) {
  return (
    <TextField
      defaultValue={defaultValue}
      inputMode="decimal"
      label={label}
      name={name}
      pattern="[0-9]+([.,][0-9]{1,2})?"
      placeholder="0.00"
    />
  )
}

/**
 * A draft raised from a sales order arrives unclassified. Revising replaces the draft's
 * terms wholesale, so the form resends them with the chosen category.
 */
export function ClassifyForm({
  detail,
  categories,
  busy,
  onSubmit,
}: {
  detail: ReceivableDetail
  categories: Category[]
  busy: boolean
  onSubmit: (terms: Record<string, unknown>) => Promise<void>
}) {
  const t = useTranslations('receivables')
  const options = categories
    .filter((category) => category.active && category.nature === 'revenue')
    .map((category) => ({ value: category.id, label: `${category.code} · ${category.name}` }))
  if (!options.length) return <p className="catalog-page-copy">{t('noRevenueCategories')}</p>

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await onSubmit({
      partyId: detail.partyId,
      documentNumber: detail.documentNumber,
      description: detail.description ?? '',
      currency: detail.currency,
      categoryId: String(new FormData(event.currentTarget).get('categoryId') ?? ''),
      issuedOn: detail.issuedOn,
      competenceOn: detail.competenceOn,
      installments: detail.installments.map(({ dueOn, amount }) => ({ dueOn, amount })),
    })
  }

  return (
    <form className="receivable-inline-form receivable-classify" onSubmit={submit}>
      <SelectField
        defaultValue={detail.categoryId ?? options[0]?.value ?? null}
        label={t('category')}
        name="categoryId"
        options={options}
      />
      <div className="dialog-actions">
        <Button disabled={busy} type="submit" variant="secondary">
          {t('saveClassification')}
        </Button>
      </div>
    </form>
  )
}
