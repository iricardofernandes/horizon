'use client'

import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog } from '@base-ui/react/dialog'
import { Envelope, IdentificationCard, Plus, Trash, User, X } from '@phosphor-icons/react'
import { type FormEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { tracedFetch } from '@/lib/telemetry'

export type Customer = {
  id: string
  name: string
  taxId: string
  email: string
  phone: string
  address: string
  status: 'active' | 'erased'
  createdAt?: string
}

export function CustomersView({
  customers,
  onChanged,
  setNotice,
}: {
  customers: Customer[]
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = customers.filter(
    (customer) =>
      !normalizedQuery ||
      customer.name.toLocaleLowerCase().includes(normalizedQuery) ||
      customer.email.toLocaleLowerCase().includes(normalizedQuery) ||
      customer.taxId.includes(normalizedQuery),
  )

  return (
    <section>
      <header className="page-heading page-heading-with-actions">
        <div>
          <p className="eyebrow">Sales directory</p>
          <h1>Customers</h1>
          <p className="catalog-page-copy">
            Keep the people and companies behind every commercial relationship organized.
          </p>
        </div>
        <div className="page-actions">
          <CreateCustomerDialog onChanged={onChanged} setNotice={setNotice} />
        </div>
      </header>

      <div className="customer-summary-grid">
        <article className="customer-summary-card">
          <span>Active customers</span>
          <strong>{customers.filter((customer) => customer.status === 'active').length}</strong>
        </article>
        <article className="customer-summary-card">
          <span>Protected records</span>
          <strong>{customers.filter((customer) => customer.status === 'erased').length}</strong>
        </article>
        <label className="customer-search">
          <span className="sr-only">Search customers</span>
          <input
            aria-label="Search customers"
            className="ui-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, email or tax ID…"
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
                <th>Customer</th>
                <th>Tax ID</th>
                <th>Phone</th>
                <th>Address</th>
                <th>Status</th>
                <th aria-label="Actions" />
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
                        <strong>{customer.name}</strong>
                        <small>
                          <Envelope aria-hidden="true" size={11} /> {customer.email}
                        </small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="customer-tax-id">
                      <IdentificationCard aria-hidden="true" size={15} />
                      {formatTaxId(customer.taxId)}
                    </span>
                  </td>
                  <td>{customer.phone}</td>
                  <td className="customer-address">{customer.address}</td>
                  <td>
                    <Badge status={customer.status} />
                  </td>
                  <td>
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
            <strong>No customers found</strong>
            <p>Create a customer or adjust your search.</p>
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
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = event.currentTarget
    const data = new FormData(form)
    const response = await tracedFetch('sales.customer.create', '/api/horizon/sales/customers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: String(data.get('name') ?? '').trim(),
        taxId: String(data.get('taxId') ?? '').trim(),
        email: String(data.get('email') ?? '').trim(),
        phone: String(data.get('phone') ?? '').trim(),
        address: String(data.get('address') ?? '').trim(),
      }),
    })
    if (!response.ok) {
      setError(await apiError(response, 'The customer could not be created.'))
      setBusy(false)
      return
    }
    form.reset()
    setOpen(false)
    setNotice('Customer created successfully.')
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary">
        <Plus aria-hidden="true" size={17} weight="bold" />
        New customer
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup customer-dialog">
          <div className="dialog-heading">
            <Dialog.Title>Create customer</Dialog.Title>
            <Dialog.Description className="dialog-description">
              Personal data is encrypted per customer and isolated to this workspace.
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
            <X aria-hidden="true" size={18} weight="bold" />
          </Dialog.Close>
          <form className="dialog-form" onSubmit={submit}>
            <TextField label="Name" maxLength={160} minLength={2} name="name" required />
            <div className="form-grid two-columns">
              <TextField
                description="CPF or CNPJ. Formatting is optional."
                label="Tax ID"
                maxLength={18}
                minLength={11}
                name="taxId"
                placeholder="000.000.000-00"
                required
              />
              <TextField label="Email" maxLength={254} name="email" required type="email" />
            </div>
            <TextField
              description="8 to 15 digits, optionally prefixed with +."
              label="Phone"
              maxLength={24}
              minLength={8}
              name="phone"
              placeholder="+55 11 99999-0000"
              required
              type="tel"
            />
            <TextField
              label="Address"
              maxLength={500}
              minLength={5}
              name="address"
              placeholder="Street, number, city and state"
              required
            />
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <Dialog.Close className="ui-button ui-button-secondary">Cancel</Dialog.Close>
              <Button disabled={busy} type="submit" variant="primary">
                {busy ? 'Saving…' : 'Create customer'}
              </Button>
            </div>
          </form>
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
  customer: Customer
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function erase() {
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      'sales.customer.erase',
      `/api/horizon/sales/customers/${customer.id}`,
      { method: 'DELETE' },
    )
    if (!response.ok) {
      setError(await apiError(response, 'The customer data could not be erased.'))
      setBusy(false)
      return
    }
    setNotice(`${customer.name}'s personal data was permanently erased.`)
    await onChanged()
    setOpen(false)
    setBusy(false)
  }

  return (
    <AlertDialog.Root onOpenChange={setOpen} open={open}>
      <AlertDialog.Trigger className="ui-button ui-button-ghost row-action-button danger-action">
        <Trash aria-hidden="true" size={16} />
        Erase data
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-dialog-backdrop" />
        <AlertDialog.Popup className="ui-dialog-popup ui-alert-popup">
          <div className="dialog-heading">
            <AlertDialog.Title>Erase {customer.name}&apos;s personal data?</AlertDialog.Title>
            <AlertDialog.Description className="dialog-description">
              This crypto-shredding operation is permanent. Historical documents retain an anonymous
              reference, and this customer cannot be used in new orders.
            </AlertDialog.Description>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <AlertDialog.Close className="ui-button ui-button-secondary">Cancel</AlertDialog.Close>
            <Button disabled={busy} onClick={erase} type="button" variant="danger">
              {busy ? 'Erasing…' : 'Erase personal data'}
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

function formatTaxId(value: string) {
  const digits = value.replace(/\D/g, '')
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')
  if (digits.length === 14)
    return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
  return value
}
