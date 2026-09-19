'use client'

import { Dialog } from '@base-ui/react/dialog'
import { X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { LoadingState, Notice } from '@/components/ui/state'
import { apiError, readJson } from '@/lib/api'
import { idempotentJsonHeaders, jsonHeaders } from '@/lib/http'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import { useDate, useMoney, useQuantity } from '@/lib/use-format'
import { QuoteFields, quoteBody } from './quote-form'
import type { SalesScreenData } from './sales-page'
import { historyOf, type Quote, reference, SALES_API, type SalesAbilities } from './types'

type Command = (name: string, path: string, body?: unknown, idempotent?: boolean) => Promise<void>

/**
 * One offer: what it says now, how it got there, and what can still be done to it.
 *
 * The versions are in the dialog rather than on a screen of their own because a price is
 * only readable against the price it replaced. Somebody deciding whether to allow a
 * discount is deciding about a movement, not about a number.
 */
export function QuoteDialog({
  quote,
  data,
  abilities,
  onClose,
  onChanged,
}: {
  quote: Quote
  data: SalesScreenData
  abilities: SalesAbilities
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('sales')
  const common = useTranslations('common')
  const [quoteId, setQuoteId] = useState(quote.id)
  const [detail, setDetail] = useState<Quote | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setDetail(await readJson<Quote>('sales.quote', `${SALES_API}/quotes/${quoteId}`))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [quoteId])

  useEffect(() => {
    void load()
  }, [load])

  const command: Command = async (name, path, body, idempotent = false) => {
    setBusy(true)
    setError('')
    const response = await tracedFetch(name, path, {
      method: 'POST',
      headers: idempotent ? idempotentJsonHeaders() : jsonHeaders(),
      body: JSON.stringify(body ?? {}),
    })
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('actionFailed')))
      return
    }
    // A revision of an offer already on the table is a new version of it: follow the answer.
    const revised = (await response.json().catch(() => null)) as { quoteId?: string } | null
    if (revised?.quoteId && revised.quoteId !== quoteId) setQuoteId(revised.quoteId)
    await Promise.all([load(), onChanged()])
  }

  return (
    <Dialog.Root onOpenChange={(open) => (open ? undefined : onClose())} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup document-dialog">
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {failed ? <Notice copy={t('detailUnavailable')} /> : null}
          {!failed && !detail ? <LoadingState /> : null}
          {detail ? (
            <Body
              abilities={abilities}
              busy={busy}
              data={data}
              detail={detail}
              error={error}
              onCommand={command}
            />
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Body({
  detail,
  data,
  abilities,
  busy,
  error,
  onCommand,
}: {
  detail: Quote
  data: SalesScreenData
  abilities: SalesAbilities
  busy: boolean
  error: string
  onCommand: Command
}) {
  const t = useTranslations('sales')
  const label = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  const [revising, setRevising] = useState(false)
  const base = `${SALES_API}/quotes/${detail.id}`
  const customer = data.customers.find((row) => row.id === detail.customerId)

  return (
    <>
      <div className="dialog-heading">
        <Dialog.Title>
          {t('quoteTitle', { id: reference('QT', detail.rootId), version: detail.version })}
        </Dialog.Title>
        <Badge label={label(detail.status)} status={detail.status} />
      </div>
      <dl className="document-facts">
        <div>
          <dt>{t('customer')}</dt>
          <dd>{customer?.name ?? reference('CU', detail.customerId)}</dd>
        </div>
        <div>
          <dt>{t('total')}</dt>
          <dd>{money(detail.total, detail.currency)}</dd>
        </div>
        <div>
          <dt>{t('discount')}</dt>
          <dd>{money(detail.discount, detail.currency)}</dd>
        </div>
        <div>
          <dt>{t('freight')}</dt>
          <dd>
            {money(detail.freight, detail.currency)}
            {detail.carrier ? ` · ${detail.carrier}` : ''}
          </dd>
        </div>
        <div>
          <dt>{t('paymentTerms')}</dt>
          <dd>{t('inDays', { days: detail.paymentTermDays.join(', ') })}</dd>
        </div>
        <div>
          <dt>{t('expires')}</dt>
          <dd>{date(detail.expiresAt)}</dd>
        </div>
      </dl>

      <Approval abilities={abilities} detail={detail} />

      <h3 className="document-section-title">{t('pricedLines')}</h3>
      {revising ? (
        <ReviseForm
          busy={busy}
          data={data}
          detail={detail}
          onCancel={() => setRevising(false)}
          onCommand={onCommand}
        />
      ) : (
        <Lines detail={detail} />
      )}

      <h3 className="document-section-title">{t('negotiation')}</h3>
      <History detail={detail} quotes={data.quotes} />

      {error ? <Notice copy={error} /> : null}

      {abilities.canWrite && !revising ? (
        <Decisions
          abilities={abilities}
          base={base}
          busy={busy}
          data={data}
          detail={detail}
          onCommand={onCommand}
          onRevise={() => setRevising(true)}
        />
      ) : null}
    </>
  )
}

/** Who asked for the discount, who decided, and why — or why this reader may not. */
function Approval({ detail, abilities }: { detail: Quote; abilities: SalesAbilities }) {
  const t = useTranslations('sales')
  const label = useStatusLabel()
  if (detail.approvalState === 'none') return null
  const own = detail.approvalRequestedBy === abilities.userId
  return (
    <div className="document-approval">
      <Badge label={label(detail.approvalState)} status={detail.approvalState} />
      {detail.approvalRequestedBy ? (
        <span>{t('requestedBy', { who: detail.approvalRequestedBy })}</span>
      ) : null}
      {detail.approvalDecidedBy ? (
        <span>{t('decidedBy', { who: detail.approvalDecidedBy })}</span>
      ) : null}
      {detail.approvalReason ? <span>{detail.approvalReason}</span> : null}
      {detail.approvalState === 'pending' && own ? (
        <p className="document-note">{t('ownApproval')}</p>
      ) : null}
    </div>
  )
}

function Lines({ detail }: { detail: Quote }) {
  const t = useTranslations('sales')
  const money = useMoney()
  const quantity = useQuantity()
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t('line')}</th>
            <th className="numeric">{t('quantity')}</th>
            <th className="numeric">{t('unitPrice')}</th>
            <th className="numeric">{t('lineTotal')}</th>
          </tr>
        </thead>
        <tbody>
          {detail.lines.map((line) => (
            <tr key={line.lineId}>
              <td>{line.description}</td>
              <td className="numeric">{quantity(line.quantity)}</td>
              <td className="numeric">{money(line.unitPrice, detail.currency)}</td>
              <td className="numeric">{money(line.lineTotal, detail.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Every version of this offer, newest first, and what closed each one. */
function History({ detail, quotes }: { detail: Quote; quotes: readonly Quote[] }) {
  const t = useTranslations('sales')
  const label = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  const versions = historyOf(quotes, detail.rootId)
  if (versions.length <= 1) return <p className="document-note">{t('firstVersion')}</p>
  return (
    <ul className="document-timeline">
      {versions.map((version) => (
        <li key={version.id}>
          <div className="document-timeline-head">
            <strong>{t('versionNumber', { version: version.version })}</strong>
            <Badge label={label(version.status)} status={version.status} />
            <span>{money(version.total, version.currency)}</span>
            <span>{date(version.createdAt)}</span>
          </div>
          <p className="document-note">
            {t('discountOf', { amount: money(version.discount, version.currency) })}
            {version.closureReason ? ` · ${version.closureReason}` : ''}
          </p>
        </li>
      ))}
    </ul>
  )
}

/** The answer to an offer: the same fields again, starting from what is on the table. */
function ReviseForm({
  detail,
  data,
  busy,
  onCommand,
  onCancel,
}: {
  detail: Quote
  data: SalesScreenData
  busy: boolean
  onCommand: Command
  onCancel: () => void
}) {
  const t = useTranslations('sales')
  const common = useTranslations('common')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await onCommand(
      'sales.quote.revise',
      `${SALES_API}/quotes/${detail.id}/revise`,
      quoteBody(new FormData(event.currentTarget)),
      true,
    )
    onCancel()
  }
  return (
    <form className="dialog-form" onSubmit={submit}>
      <QuoteFields
        draft={{
          lines: detail.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
          discount: detail.discount,
          freight: detail.freight,
          carrier: detail.carrier,
          paymentTermDays: detail.paymentTermDays,
          notes: detail.notes,
        }}
        items={data.items}
      />
      <div className="dialog-actions">
        <Button onClick={onCancel} type="button" variant="secondary">
          {common('cancel')}
        </Button>
        <Button disabled={busy} type="submit" variant="primary">
          {t('saveVersion')}
        </Button>
      </div>
    </form>
  )
}

/** What can still be done to this offer, and by this reader. */
function Decisions({
  detail,
  data,
  abilities,
  base,
  busy,
  onCommand,
  onRevise,
}: {
  detail: Quote
  data: SalesScreenData
  abilities: SalesAbilities
  base: string
  busy: boolean
  onCommand: Command
  onRevise: () => void
}) {
  const t = useTranslations('sales')
  const [reason, setReason] = useState('')
  const [warehouse, setWarehouse] = useState(
    () => data.warehouses.find((row) => row.active)?.id ?? '',
  )
  const decidable =
    detail.approvalState === 'pending' && detail.approvalRequestedBy !== abilities.userId
  const open = detail.status === 'sent'
  const reasoned = reason.trim().length >= 3

  return (
    <div className="dialog-actions">
      <label className="document-reason">
        <span className="ui-field-label">{t('reason')}</span>
        <input
          className="ui-input"
          onChange={(event) => setReason(event.target.value)}
          value={reason}
        />
      </label>
      {detail.status === 'draft' || open ? (
        <Button disabled={busy} onClick={onRevise} type="button" variant="secondary">
          {t('revise')}
        </Button>
      ) : null}
      {detail.status === 'draft' ? (
        <Button disabled={busy} onClick={() => onCommand('sales.quote.send', `${base}/send`)}>
          {t('send')}
        </Button>
      ) : null}
      {decidable ? (
        <>
          <Button
            disabled={busy || !reasoned}
            onClick={() => onCommand('sales.quote.refuse', `${base}/refuse`, { reason })}
            variant="secondary"
          >
            {t('refuse')}
          </Button>
          <Button
            disabled={busy}
            onClick={() => onCommand('sales.quote.approve', `${base}/approve`)}
          >
            {t('approve')}
          </Button>
        </>
      ) : null}
      {open ? (
        <>
          <Button disabled={busy} onClick={() => onCommand('sales.quote.expire', `${base}/expire`)}>
            {t('expire')}
          </Button>
          <Button
            disabled={busy || !reasoned}
            onClick={() => onCommand('sales.quote.decline', `${base}/decline`, { reason })}
            variant="secondary"
          >
            {t('decline')}
          </Button>
          <Button disabled={busy} onClick={() => onCommand('sales.quote.accept', `${base}/accept`)}>
            {t('accept')}
          </Button>
        </>
      ) : null}
      {detail.status === 'accepted' && !detail.orderId ? (
        <>
          <SelectField
            label={t('warehouse')}
            name="fulfillmentWarehouseId"
            onValueChange={(value) => setWarehouse(value ?? '')}
            options={data.warehouses
              .filter((row) => row.active)
              .map((row) => ({ label: row.name, value: row.id }))}
            value={warehouse}
          />
          <Button
            disabled={busy || !warehouse}
            onClick={() =>
              onCommand(
                'sales.quote.convert',
                `${base}/order`,
                { fulfillmentWarehouseId: warehouse },
                true,
              )
            }
            variant="primary"
          >
            {t('convert')}
          </Button>
        </>
      ) : null}
      {detail.orderId ? (
        <p className="document-note">{t('becameOrder', { id: reference('SO', detail.orderId) })}</p>
      ) : null}
    </div>
  )
}
