'use client'

import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog } from '@base-ui/react/dialog'
import { Envelope, IdentificationCard, Plus, Trash, User, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { maskedDocument, type Party, type PartyRole } from '@/features/parties/party'
import { PartyRegistrationForm } from '@/features/parties/party-registration-form'
import { CustomerServicesDialog } from '@/features/services/customer-services-dialog'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'

const CUSTOMER_ROLES: readonly PartyRole[] = ['customer']

/** Sales' projection of a party holding the customer role, as quotes and orders read it. */
export type Customer = {
  id: string
  name: string
  taxId: string | null
  email: string
  phone: string
  address: string
  status: 'active' | 'inactive' | 'erased'
  createdAt?: string
}

/**
 * Customers are parties holding the `customer` role (ADR 0040). This screen reads and
 * writes the registry; Sales follows it through events.
 */
export function CustomersView({
  customers,
  onChanged,
  setNotice,
}: {
  customers: Party[]
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const t = useTranslations('customers')
  const common = useTranslations('common')
  const statusLabel = useStatusLabel()
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = customers.filter(
    (customer) =>
      !normalizedQuery ||
      customer.legalName.toLocaleLowerCase().includes(normalizedQuery) ||
      (customer.email ?? '').toLocaleLowerCase().includes(normalizedQuery) ||
      (customer.document.suffix ?? '').includes(normalizedQuery),
  )

  return (
    <section>
      <header className="page-heading page-heading-with-actions">
        <div>
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{t('title')}</h1>
          <p className="catalog-page-copy">{t('copy')}</p>
        </div>
        <div className="page-actions">
          <CreateCustomerDialog onChanged={onChanged} setNotice={setNotice} />
        </div>
      </header>

      <div className="customer-summary-grid">
        <article className="customer-summary-card">
          <span>{t('activeCustomers')}</span>
          <strong>{customers.filter((customer) => customer.status === 'active').length}</strong>
        </article>
        <article className="customer-summary-card">
          <span>{t('protectedRecords')}</span>
          <strong>{customers.filter((customer) => customer.status === 'erased').length}</strong>
        </article>
        <label className="customer-search">
          <span className="sr-only">{t('search')}</span>
          <input
            aria-label={t('search')}
            className="ui-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchPlaceholder')}
            type="search"
            value={query}
          />
        </label>
      </div>

      <div className="panel table-panel customer-table-panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('customer')}</th>
                <th>{t('taxId')}</th>
                <th>{t('phone')}</th>
                <th>{t('address')}</th>
                <th>{t('status')}</th>
                <th aria-label={common('actions')} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((customer) => (
                <tr key={customer.id}>
                  <td>
                    <div className="resource-name customer-identity">
                      <span className="resource-icon" aria-hidden="true">
                        <User size={17} />
                      </span>
                      <span>
                        <strong>{customer.legalName}</strong>
                        <small>
                          <Envelope aria-hidden="true" size={11} /> {customer.email ?? '—'}
                        </small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="customer-tax-id">
                      <IdentificationCard aria-hidden="true" size={15} />
                      {maskedDocument(customer)}
                    </span>
                  </td>
                  <td>{customer.phone ?? '—'}</td>
                  <td className="customer-address">{customer.address}</td>
                  <td>
                    <Badge status={customer.status} label={statusLabel(customer.status)} />
                  </td>
                  <td className="customer-actions">
                    {customer.status !== 'erased' ? (
                      <CustomerServicesDialog customerId={customer.id} name={customer.legalName} />
                    ) : null}
                    {customer.status === 'active' ? (
                      <EraseCustomerDialog
                        customer={customer}
                        onChanged={onChanged}
                        setNotice={setNotice}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length ? (
          <div className="catalog-empty">
            <strong>{t('emptyTitle')}</strong>
            <p>{t('emptyCopy')}</p>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function CreateCustomerDialog({
  onChanged,
  setNotice,
}: {
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const t = useTranslations('customers')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary">
        <Plus aria-hidden="true" size={17} weight="bold" />
        {t('create')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup customer-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{t('createTitle')}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('createDescription')}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} weight="bold" />
          </Dialog.Close>
          <PartyRegistrationForm
            failedLabel={t('createFailed')}
            onRegistered={async () => {
              setOpen(false)
              setNotice(t('created'))
              await onChanged()
            }}
            roles={CUSTOMER_ROLES}
            submitLabel={t('createSubmit')}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function EraseCustomerDialog({
  customer,
  onChanged,
  setNotice,
}: {
  customer: Party
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const t = useTranslations('customers')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function erase() {
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      'parties.party.erase',
      `/api/horizon/parties/parties/${customer.id}`,
      { method: 'DELETE' },
    )
    if (!response.ok) {
      setError(await apiError(response, t('eraseFailed')))
      setBusy(false)
      return
    }
    setNotice(t('erased', { name: customer.legalName }))
    await onChanged()
    setOpen(false)
    setBusy(false)
  }

  return (
    <AlertDialog.Root onOpenChange={setOpen} open={open}>
      <AlertDialog.Trigger className="ui-button ui-button-ghost row-action-button danger-action">
        <Trash aria-hidden="true" size={16} />
        {t('erase')}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-dialog-backdrop" />
        <AlertDialog.Popup className="ui-dialog-popup ui-alert-popup">
          <div className="dialog-heading">
            <AlertDialog.Title>{t('eraseTitle', { name: customer.legalName })}</AlertDialog.Title>
            <AlertDialog.Description className="dialog-description">
              {t('eraseDescription')}
            </AlertDialog.Description>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <AlertDialog.Close className="ui-button ui-button-secondary">
              {common('cancel')}
            </AlertDialog.Close>
            <Button disabled={busy} onClick={erase} type="button" variant="danger">
              {busy ? t('erasing') : t('eraseSubmit')}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

async function apiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown; message?: unknown; title?: unknown }
    const message = body.detail ?? body.message ?? body.title
    if (Array.isArray(message)) return message.join(' ')
    if (typeof message === 'string' && message.trim()) return message
  } catch {
    // Empty and non-JSON responses use the stable fallback below.
  }
  return fallback
}
