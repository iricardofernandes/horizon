'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Plus, Trash, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Board, BoardCard } from '@/components/ui/board'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { reference } from '@/features/sales/types'
import { minorUnits } from '@/lib/format'
import { useMoney } from '@/lib/use-format'
import { ServiceOrderDialog } from './service-order-dialog'
import { command, nameOf, type ServicesData } from './services-data'
import {
  deliveredShare,
  SALES_API,
  SERVICE_ORDER_COLUMNS,
  type ServiceOrder,
  utcToday,
} from './types'

/**
 * Services sold and delivered stage by stage (ADR 0056). A card opens the order, where
 * the work is recorded delivery by delivery and each delivery shows what it raised in
 * Financial and Fiscal.
 */
export function ServiceOrdersView({
  data,
  canWrite,
  onChanged,
}: {
  data: ServicesData
  canWrite: boolean
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('services')
  const money = useMoney()
  const [open, setOpen] = useState<ServiceOrder | null>(null)
  return (
    <section>
      <header className="page-heading page-heading-with-actions">
        <div>
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{t('orders.title')}</h1>
          <p className="catalog-page-copy">{t('orders.copy')}</p>
        </div>
        <div className="page-actions">
          {canWrite ? <NewServiceOrderDialog data={data} onChanged={onChanged} /> : null}
        </div>
      </header>
      <Board
        columnOf={(row) => row.status}
        columns={SERVICE_ORDER_COLUMNS}
        emptyLabel={t('columnEmpty')}
        keyOf={(row) => row.id}
        labelOf={(column) => t(`orders.column.${column}`)}
        renderCard={(row) => (
          <BoardCard
            label={t('orders.open', { id: reference('OS', row.id) })}
            onOpen={() => setOpen(row)}
            title={reference('OS', row.id)}
          >
            <span className="board-card-line">{nameOf(data.customers, row.customerId)}</span>
            <span className="board-card-line">{money(row.total, row.currency)}</span>
            <span className="board-card-line">
              {t('orders.delivered', { share: deliveredShare(row.lines) })}
            </span>
          </BoardCard>
        )}
        rows={data.orders}
      />
      {open ? (
        <ServiceOrderDialog
          canWrite={canWrite}
          data={data}
          onChanged={onChanged}
          onClose={() => setOpen(null)}
          orderId={open.id}
        />
      ) : null}
    </section>
  )
}

/** A service order opened directly: services only, priced from the Catalog. */
function NewServiceOrderDialog({
  data,
  onChanged,
}: {
  data: ServicesData
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('services')
  const common = useTranslations('common')
  const setNotice = useNotice()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const customers = data.customers.filter((customer) => customer.status === 'active')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const quantities = form.getAll('quantity').map(String)
    const discount = minorUnits(String(form.get('discount') ?? '0') || '0')
    const days = String(form.get('paymentTermDays') ?? '')
      .split(',')
      .map((day) => Number(day.trim()))
      .filter((day) => Number.isInteger(day) && day >= 0)
    const scheduledFor = String(form.get('scheduledFor') ?? '')
    setBusy(true)
    setError('')
    const result = await command('sales.service-order.open', `${SALES_API}/service-orders`, {
      idempotent: true,
      fallback: t('failed'),
      body: {
        customerId: form.get('customerId'),
        lines: form.getAll('itemId').map((itemId, index) => ({
          lineId: crypto.randomUUID(),
          itemId: String(itemId),
          quantity: quantities[index] ?? '1',
        })),
        terms: {
          discount: discount ?? '0',
          ...(days.length > 0 ? { paymentTermDays: days } : {}),
        },
        ...(scheduledFor ? { scheduledFor } : {}),
      },
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setOpen(false)
    setNotice(t('orders.created'))
    await onChanged()
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger
        className="ui-button ui-button-primary"
        disabled={customers.length === 0 || data.services.length === 0}
      >
        <Plus aria-hidden="true" size={17} />
        {t('orders.create')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup quote-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{t('orders.createTitle')}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('orders.createDescription')}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <form className="dialog-form" key={String(open)} onSubmit={submit}>
            <SelectField
              label={t('customer')}
              name="customerId"
              options={customers.map((customer) => ({ label: customer.name, value: customer.id }))}
              required
            />
            <ServiceLines data={data} />
            <div className="form-grid two-columns">
              <TextField
                defaultValue="0.00"
                inputMode="decimal"
                label={t('discount')}
                name="discount"
                pattern="[0-9]+([.,][0-9]{1,2})?"
              />
              <TextField
                defaultValue="30"
                label={t('paymentTerms')}
                name="paymentTermDays"
                pattern="[0-9]+([,][0-9]+)*"
                required
              />
              <TextField
                defaultValue={utcToday()}
                label={t('orders.scheduledFor')}
                name="scheduledFor"
                type="date"
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
                {t('orders.createSubmit')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * Service lines: a Catalog service and a quantity each. With `prices`, a line can carry a
 * negotiated unit price (contracts); without, the Catalog price applies (service orders).
 */
export function ServiceLines({
  data,
  prices = false,
}: {
  data: Pick<ServicesData, 'services'>
  prices?: boolean
}) {
  const t = useTranslations('services')
  const [lines, setLines] = useState([0])
  const [next, setNext] = useState(1)
  return (
    <>
      <div className="order-lines-heading">
        <strong>{t('lines')}</strong>
        <Button
          disabled={lines.length >= 100}
          onClick={() => {
            setLines((current) => [...current, next])
            setNext((current) => current + 1)
          }}
          type="button"
          variant="secondary"
        >
          <Plus aria-hidden="true" size={15} />
          {t('addLine')}
        </Button>
      </div>
      <div className="order-lines">
        {lines.map((key, position) => (
          <div className={prices ? 'order-line service-line-priced' : 'order-line'} key={key}>
            <SelectField
              label={t('service', { index: position + 1 })}
              name="itemId"
              options={data.services.map((item) => ({
                label: `${item.name} · ${item.sku}`,
                value: item.id,
              }))}
              required
            />
            <TextField
              defaultValue="1"
              inputMode="decimal"
              label={t('quantity')}
              name="quantity"
              pattern="[0-9]+([.][0-9]{1,6})?"
              required
            />
            {prices ? (
              <TextField
                description={t('negotiatedHint')}
                inputMode="decimal"
                label={t('negotiatedPrice')}
                name="unitPrice"
                pattern="[0-9]+([.,][0-9]{1,2})?"
              />
            ) : null}
            <Button
              aria-label={t('removeLine', { index: position + 1 })}
              className="remove-order-line"
              disabled={lines.length === 1}
              onClick={() => setLines((current) => current.filter((row) => row !== key))}
              type="button"
            >
              <Trash aria-hidden="true" size={16} />
            </Button>
          </div>
        ))}
      </div>
    </>
  )
}
