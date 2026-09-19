'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Plus, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import type { Customer } from '@/features/sales/customers-view'
import { apiError } from '@/lib/api'
import { idempotentJsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { EMPTY_DRAFT, QuoteFields, quoteBody } from './quote-form'
import { SALES_API } from './types'

/** An offer, before it is an offer: the goods, the terms, and who it is for. */
export function NewQuoteDialog({
  customers,
  items,
  onChanged,
}: {
  customers: readonly Customer[]
  items: readonly CatalogItem[]
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('sales')
  const common = useTranslations('common')
  const setNotice = useNotice()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const data = new FormData(event.currentTarget)
    const body = quoteBody(data)
    const response = await tracedFetch('sales.quote.create', `${SALES_API}/quotes`, {
      method: 'POST',
      headers: idempotentJsonHeaders(),
      body: JSON.stringify({ customerId: data.get('customerId'), ...body }),
    })
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('createFailed')))
      return
    }
    setOpen(false)
    setNotice(t('created'))
    await onChanged()
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger
        className="ui-button ui-button-primary"
        disabled={customers.length === 0 || items.length === 0}
      >
        <Plus aria-hidden="true" size={17} />
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
          {/* Remounted per opening, so a cancelled offer never seeds the next one. */}
          <form className="dialog-form" key={String(open)} onSubmit={submit}>
            <SelectField
              label={t('customer')}
              name="customerId"
              options={customers
                .filter((customer) => customer.status === 'active')
                .map((customer) => ({ label: customer.name, value: customer.id }))}
              required
            />
            <QuoteFields draft={EMPTY_DRAFT} items={items} />
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
                {busy ? t('creating') : t('createSubmit')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
