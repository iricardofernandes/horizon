'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Plus, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { Empty } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { reference } from '@/features/sales/types'
import { minorUnits } from '@/lib/format'
import { useStatusLabel } from '@/lib/status'
import { useDate, useMoney } from '@/lib/use-format'
import { ContractDialog } from './contract-dialog'
import { ServiceLines } from './service-orders-view'
import { command, nameOf, type ServicesData } from './services-data'
import { periodAmount, periodEnd, RECURRENCES, revisionInForce, SALES_API, utcToday } from './types'

const TERMS = ['12', '24', '36', 'open'] as const

/**
 * Services sold for a recurring fee (ADR 0056). What a contract bills lives in revisions
 * that apply from a period start; the detail shows them, the schedule and every billed
 * period with what it raised.
 */
export function ContractsView({
  data,
  canWrite,
  onChanged,
}: {
  data: ServicesData
  canWrite: boolean
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('services')
  const label = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  const [open, setOpen] = useState<string | null>(null)
  const today = utcToday()
  return (
    <section>
      <header className="page-heading page-heading-with-actions">
        <div>
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{t('contracts.title')}</h1>
          <p className="catalog-page-copy">{t('contracts.copy')}</p>
        </div>
        <div className="page-actions">
          {canWrite ? <NewContractDialog data={data} onChanged={onChanged} /> : null}
        </div>
      </header>
      <div className="panel table-panel">
        {data.contracts.length === 0 ? (
          <Empty copy={t('contracts.empty')} />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('contracts.contract')}</th>
                  <th>{t('customer')}</th>
                  <th>{t('contracts.recurrence')}</th>
                  <th className="numeric">{t('contracts.perPeriod')}</th>
                  <th>{t('contracts.term')}</th>
                  <th>{t('status')}</th>
                  <th aria-label={t('actions')} />
                </tr>
              </thead>
              <tbody>
                {data.contracts.map((contract) => {
                  const revision =
                    revisionInForce(contract.revisions, today) ?? contract.revisions[0] ?? null
                  return (
                    <tr key={contract.id}>
                      <td>
                        <code>{reference('CTR', contract.id)}</code>
                      </td>
                      <td>{nameOf(data.customers, contract.customerId)}</td>
                      <td>{revision ? t(`recurrence.${revision.recurrence}`) : '—'}</td>
                      <td className="numeric">
                        {revision ? money(periodAmount(revision), contract.currency) : '—'}
                      </td>
                      <td>
                        {date(contract.startsOn)} –{' '}
                        {contract.endsOn ? date(contract.endsOn) : t('contracts.openEnded')}
                      </td>
                      <td>
                        <Badge label={label(contract.status)} status={contract.status} />
                      </td>
                      <td>
                        <Button
                          aria-label={t('contracts.open', { id: reference('CTR', contract.id) })}
                          onClick={() => setOpen(contract.id)}
                          type="button"
                          variant="secondary"
                        >
                          {t('open')}
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {open ? (
        <ContractDialog
          canWrite={canWrite}
          contractId={open}
          data={data}
          onChanged={onChanged}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </section>
  )
}

/** The first of next month, where a new contract usually starts. */
function nextMonthStart(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 7)
}

/** A draft contract: services, recurrence, start, term and billing day. */
function NewContractDialog({
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
    const text = (name: string) => String(form.get(name) ?? '').trim()
    const startsOn = `${text('startsMonth')}-01`
    const recurrence = text('recurrence')
    const term = text('term')
    const quantities = form.getAll('quantity').map(String)
    const prices = form.getAll('unitPrice').map(String)
    const days = text('paymentTermDays')
      .split(',')
      .map((day) => Number(day.trim()))
      .filter((day) => Number.isInteger(day) && day >= 0)
    setBusy(true)
    setError('')
    const result = await command('sales.contract.create', `${SALES_API}/contracts`, {
      idempotent: true,
      fallback: t('failed'),
      body: {
        customerId: text('customerId'),
        lines: form.getAll('itemId').map((itemId, index) => {
          const price = minorUnits(prices[index] ?? '')
          return {
            lineId: crypto.randomUUID(),
            itemId: String(itemId),
            quantity: quantities[index] ?? '1',
            ...(price ? { unitPrice: price } : {}),
          }
        }),
        recurrence,
        startsOn,
        ...(term === 'open' ? {} : { endsOn: periodEnd(startsOn, Number(term)) }),
        billingDay: Number(text('billingDay')),
        autoRenew: term !== 'open' && form.get('autoRenew') === 'on',
        ...(days.length > 0 ? { paymentTermDays: days } : {}),
        ...(text('notes') ? { notes: text('notes') } : {}),
      },
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setOpen(false)
    setNotice(t('contracts.created'))
    await onChanged()
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger
        className="ui-button ui-button-primary"
        disabled={customers.length === 0 || data.services.length === 0}
      >
        <Plus aria-hidden="true" size={17} />
        {t('contracts.create')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup quote-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{t('contracts.createTitle')}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('contracts.createDescription')}
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
            <ServiceLines data={data} prices />
            <div className="form-grid two-columns">
              <SelectField
                label={t('contracts.recurrence')}
                name="recurrence"
                options={RECURRENCES.map((value) => ({
                  label: t(`recurrence.${value}`),
                  value,
                }))}
              />
              <TextField
                defaultValue={nextMonthStart()}
                label={t('contracts.startsMonth')}
                name="startsMonth"
                required
                type="month"
              />
              <SelectField
                label={t('contracts.term')}
                name="term"
                options={TERMS.map((value) => ({ label: t(`contracts.terms.${value}`), value }))}
              />
              <TextField
                defaultValue="10"
                label={t('contracts.billingDay')}
                max={28}
                min={1}
                name="billingDay"
                required
                type="number"
              />
              <TextField
                defaultValue="15"
                label={t('paymentTerms')}
                name="paymentTermDays"
                pattern="[0-9]+([,][0-9]+)*"
                required
              />
              <label className="checkbox-field">
                <input name="autoRenew" type="checkbox" />
                <span>{t('contracts.autoRenew')}</span>
              </label>
            </div>
            <TextField label={t('notes')} name="notes" />
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
                {t('contracts.createSubmit')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
