'use client'

import { Dialog } from '@base-ui/react/dialog'
import { CheckCircle, Eye, FileText, Plus, Trash, X } from '@phosphor-icons/react'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import type { Customer } from '@/features/sales/customers-view'
import { tracedFetch } from '@/lib/telemetry'

export type Quote = {
  id: string
  customerId: string
  status: 'draft' | 'accepted' | 'expired'
  expiresAt: string
  total: { amount: string; currency: string }
  lines: Array<{
    lineId: string
    itemId: string
    quantity: string
    description: string
    unitPrice: string
    lineTotal: string
  }>
  createdAt: string
}

type MutationProps = {
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}

export function QuotesView({
  quotes,
  customers,
  items,
  onChanged,
  setNotice,
}: {
  quotes: Quote[]
  customers: Customer[]
  items: CatalogItem[]
} & MutationProps) {
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLocaleLowerCase()
  const filtered = quotes.filter((quote) => {
    const customer = customers.find((candidate) => candidate.id === quote.customerId)
    return (
      !normalized ||
      quote.id.toLocaleLowerCase().includes(normalized) ||
      customer?.name.toLocaleLowerCase().includes(normalized)
    )
  })

  return (
    <section>
      <header className="page-heading page-heading-with-actions">
        <div>
          <p className="eyebrow">Commercial proposals</p>
          <h1>Quotes</h1>
          <p className="catalog-page-copy">
            Price proposals with immutable item snapshots and a controlled validity window.
          </p>
        </div>
        <div className="page-actions">
          <CreateQuoteDialog
            customers={customers}
            items={items}
            onChanged={onChanged}
            setNotice={setNotice}
          />
        </div>
      </header>

      <div className="quotes-toolbar">
        <div className="quote-counts">
          <span>
            <strong>{quotes.filter((quote) => quote.status === 'draft').length}</strong> open
          </span>
          <span>
            <strong>{quotes.filter((quote) => quote.status === 'accepted').length}</strong> accepted
          </span>
        </div>
        <input
          aria-label="Search quotes"
          className="ui-input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search quote or customer…"
          type="search"
          value={query}
        />
      </div>

      <div className="panel table-panel quotes-table-panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Quote</th>
                <th>Customer</th>
                <th>Total</th>
                <th>Expires</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((quote) => (
                <tr key={quote.id}>
                  <td>
                    <div className="resource-name">
                      <span className="resource-icon">
                        <FileText aria-hidden="true" size={17} />
                      </span>
                      <code className="table-code">{short(quote.id)}</code>
                    </div>
                  </td>
                  <td>
                    {customers.find((customer) => customer.id === quote.customerId)?.name ??
                      short(quote.customerId)}
                  </td>
                  <td>
                    <strong>{money(quote.total.amount, quote.total.currency)}</strong>
                  </td>
                  <td>{new Date(quote.expiresAt).toLocaleDateString()}</td>
                  <td>
                    <StatusBadge status={displayStatus(quote)} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <QuoteDetailsDialog
                        quote={quote}
                        customer={customers.find((row) => row.id === quote.customerId)}
                      />
                      {quote.status === 'draft' && !expired(quote) ? (
                        <AcceptQuoteButton
                          quote={quote}
                          onChanged={onChanged}
                          setNotice={setNotice}
                        />
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length ? (
          <div className="catalog-empty">
            <strong>No quotes found</strong>
            <p>Create a proposal or adjust your search.</p>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function CreateQuoteDialog({
  customers,
  items,
  onChanged,
  setNotice,
}: { customers: Customer[]; items: CatalogItem[] } & MutationProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [lines, setLines] = useState([0])
  const [nextLine, setNextLine] = useState(1)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = event.currentTarget
    const data = new FormData(form)
    const itemIds = data.getAll('itemId')
    const quantities = data.getAll('quantity')
    const response = await tracedFetch('sales.quote.create', '/api/horizon/sales/quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: data.get('customerId'),
        lines: itemIds.map((itemId, index) => ({
          lineId: crypto.randomUUID(),
          itemId,
          quantity: quantities[index],
        })),
      }),
    })
    if (!response.ok) {
      setError(await apiError(response, 'The quote could not be created.'))
      setBusy(false)
      return
    }
    form.reset()
    setLines([0])
    setNextLine(1)
    setOpen(false)
    setNotice('Quote created successfully.')
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger
        className="ui-button ui-button-primary"
        disabled={!customers.length || !items.length}
      >
        <Plus aria-hidden="true" size={17} />
        New quote
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup quote-dialog">
          <div className="dialog-heading">
            <Dialog.Title>Create quote</Dialog.Title>
            <Dialog.Description className="dialog-description">
              Prices are snapshotted from the current Catalog projection.
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <form className="dialog-form" onSubmit={submit}>
            <SelectField
              label="Customer"
              name="customerId"
              options={customers
                .filter((row) => row.status === 'active')
                .map((row) => ({ label: row.name, value: row.id }))}
              required
            />
            <div className="order-lines-heading">
              <strong>Quote lines</strong>
              <Button
                disabled={lines.length >= 100}
                onClick={() => {
                  setLines((current) => [...current, nextLine])
                  setNextLine((current) => current + 1)
                }}
                type="button"
                variant="secondary"
              >
                <Plus aria-hidden="true" size={15} />
                Add line
              </Button>
            </div>
            <div className="order-lines">
              {lines.map((line, index) => (
                <div className="order-line" key={line}>
                  <SelectField
                    label={`Item ${index + 1}`}
                    name="itemId"
                    options={items
                      .filter((row) => row.active)
                      .map((row) => ({ label: `${row.name} · ${row.sku}`, value: row.id }))}
                    required
                  />
                  <TextField
                    defaultValue="1"
                    inputMode="decimal"
                    label="Quantity"
                    name="quantity"
                    pattern="[0-9]+([.][0-9]{1,6})?"
                    required
                  />
                  <Button
                    aria-label={`Remove item ${index + 1}`}
                    className="remove-order-line"
                    disabled={lines.length === 1}
                    onClick={() => setLines((current) => current.filter((value) => value !== line))}
                    type="button"
                  >
                    <Trash aria-hidden="true" size={16} />
                  </Button>
                </div>
              ))}
            </div>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <Dialog.Close className="ui-button ui-button-secondary">Cancel</Dialog.Close>
              <Button disabled={busy} type="submit" variant="primary">
                {busy ? 'Creating…' : 'Create quote'}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function QuoteDetailsDialog({ quote, customer }: { quote: Quote; customer: Customer | undefined }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger className="ui-button ui-button-ghost row-action-button">
        <Eye aria-hidden="true" size={15} />
        Details
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup order-detail-dialog">
          <div className="dialog-heading">
            <Dialog.Title>Quote {short(quote.id)}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              For {customer?.name ?? short(quote.customerId)} · valid until{' '}
              {new Date(quote.expiresAt).toLocaleString()}.
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <div className="order-detail-summary">
            <div>
              <span className="summary-label">Status</span>
              <StatusBadge status={displayStatus(quote)} />
            </div>
            <div>
              <span className="summary-label">Total</span>
              <strong>{money(quote.total.amount, quote.total.currency)}</strong>
            </div>
          </div>
          <div className="order-detail-lines">
            <h3>Priced lines</h3>
            {quote.lines.map((line) => (
              <div key={line.lineId}>
                <span>
                  <strong>{line.description}</strong>
                  <small className="detail-line-meta">
                    {line.quantity} × {money(line.unitPrice, quote.total.currency)}
                  </small>
                </span>
                <strong>{money(line.lineTotal, quote.total.currency)}</strong>
              </div>
            ))}
          </div>
          <div className="dialog-actions">
            <Dialog.Close className="ui-button ui-button-secondary">Close</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function AcceptQuoteButton({ quote, onChanged, setNotice }: { quote: Quote } & MutationProps) {
  const [busy, setBusy] = useState(false)
  async function accept() {
    setBusy(true)
    const response = await tracedFetch(
      'sales.quote.accept',
      `/api/horizon/sales/quotes/${quote.id}/accept`,
      { method: 'POST' },
    )
    setNotice(
      response.ok ? `Quote ${short(quote.id)} accepted.` : 'The quote could not be accepted.',
    )
    if (response.ok) await onChanged()
    setBusy(false)
  }
  return (
    <Button disabled={busy} onClick={accept} type="button">
      <CheckCircle aria-hidden="true" size={15} />
      {busy ? 'Accepting…' : 'Accept'}
    </Button>
  )
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>
}
function expired(quote: Quote) {
  return quote.status === 'draft' && new Date(quote.expiresAt).getTime() <= Date.now()
}
function displayStatus(quote: Quote) {
  return expired(quote) ? 'expired' : quote.status
}
function short(value: string) {
  return value.slice(0, 8)
}
function money(amount: string, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    Number(amount) / 100,
  )
}

async function apiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown; message?: unknown; title?: unknown }
    const message = body.detail ?? body.message ?? body.title
    if (typeof message === 'string' && message.trim()) return message
  } catch {}
  return fallback
}
