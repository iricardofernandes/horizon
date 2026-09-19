'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Board, BoardCard } from '@/components/ui/board'
import { Button } from '@/components/ui/button'
import { short } from '@/lib/format'
import { useStatusLabel } from '@/lib/status'
import { useDate, useMoney } from '@/lib/use-format'
import { NewQuoteDialog } from './new-quote-dialog'
import { PickDialog } from './pick-dialog'
import { QuoteDialog } from './quote-dialog'
import type { SalesScreenData } from './sales-page'
import { ShipmentDialog } from './shipment-dialog'
import {
  awaitingApproval,
  currentVersions,
  deliverable,
  QUOTE_COLUMNS,
  type Quote,
  reference,
  type SalesAbilities,
  SHIPMENT_COLUMNS,
  type Shipment,
} from './types'

export type Screen = 'quotes' | 'approvals' | 'deliveries'

/**
 * Selling, as three ways of looking at one chain of documents: what has been offered, what
 * is waiting for somebody to allow, and what is on its way out of the door.
 *
 * The approval queue is deliberately not a fourth kind of record. It is the same offers,
 * filtered to the ones whose next step is a decision — so allowing a discount there and
 * finding the offer on its board afterwards is the same document, not a copy of it.
 */
export function SalesView({
  screen,
  data,
  abilities,
  onChanged,
}: {
  screen: Screen
  data: SalesScreenData
  abilities: SalesAbilities
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('sales')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [shipment, setShipment] = useState<Shipment | null>(null)
  const waiting = awaitingApproval(data.quotes, abilities.userId)

  return (
    <section>
      <header className="page-heading page-heading-with-actions">
        <div>
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{t(`${screen}.title`)}</h1>
          <p className="catalog-page-copy">{t(`${screen}.copy`)}</p>
        </div>
        <div className="page-actions">
          {screen === 'quotes' && abilities.canWrite ? (
            <NewQuoteDialog customers={data.customers} items={data.items} onChanged={onChanged} />
          ) : null}
          {screen === 'deliveries' && abilities.canWrite ? (
            <PickDialog onChanged={onChanged} orders={deliverable(data.orders)} />
          ) : null}
        </div>
      </header>

      {screen === 'quotes' ? (
        <QuotesBoard data={data} onOpen={setQuote} rows={currentVersions(data.quotes)} />
      ) : null}
      {screen === 'approvals' ? <Inbox data={data} onOpen={setQuote} rows={waiting} /> : null}
      {screen === 'deliveries' ? (
        <DeliveriesBoard data={data} onOpen={setShipment} rows={data.shipments} />
      ) : null}

      {quote ? (
        <QuoteDialog
          abilities={abilities}
          data={data}
          onChanged={onChanged}
          onClose={() => setQuote(null)}
          quote={quote}
        />
      ) : null}
      {shipment ? (
        <ShipmentDialog
          abilities={abilities}
          data={data}
          onChanged={onChanged}
          onClose={() => setShipment(null)}
          shipment={shipment}
        />
      ) : null}
    </section>
  )
}

/** The customer a document is for, by name where the registry knows one. */
function customerNames(data: SalesScreenData): (customerId: string) => string {
  return (customerId: string) =>
    data.customers.find((customer) => customer.id === customerId)?.name ?? short(customerId)
}

function QuotesBoard({
  rows,
  data,
  onOpen,
}: {
  rows: readonly Quote[]
  data: SalesScreenData
  onOpen: (row: Quote) => void
}) {
  const t = useTranslations('sales')
  const money = useMoney()
  const date = useDate()
  const nameOf = customerNames(data)
  return (
    <Board
      columnOf={(row) => row.status}
      columns={QUOTE_COLUMNS}
      emptyLabel={t('columnEmpty')}
      keyOf={(row) => row.id}
      labelOf={(column) => t(`column.${column}`)}
      renderCard={(row) => (
        <BoardCard
          label={t('openQuote', { id: reference('QT', row.rootId) })}
          onOpen={() => onOpen(row)}
          title={reference('QT', row.rootId)}
        >
          <span className="board-card-line">{nameOf(row.customerId)}</span>
          <span className="board-card-line">{money(row.total, row.currency)}</span>
          <span className="board-card-line">
            {t('versionNumber', { version: row.version })} ·{' '}
            {t('expiresOn', { date: date(row.expiresAt) })}
          </span>
        </BoardCard>
      )}
      rows={rows}
    />
  )
}

function DeliveriesBoard({
  rows,
  data,
  onOpen,
}: {
  rows: readonly Shipment[]
  data: SalesScreenData
  onOpen: (row: Shipment) => void
}) {
  const t = useTranslations('sales')
  const money = useMoney()
  const nameOf = customerNames(data)
  return (
    <Board
      columnOf={(row) => row.status}
      columns={SHIPMENT_COLUMNS}
      emptyLabel={t('columnEmpty')}
      keyOf={(row) => row.id}
      labelOf={(column) => t(`column.${column}`)}
      renderCard={(row) => {
        const order = data.orders.find((candidate) => candidate.id === row.orderId)
        return (
          <BoardCard
            label={t('openShipment', { id: reference('SH', row.id) })}
            onOpen={() => onOpen(row)}
            title={reference('SH', row.id)}
          >
            <span className="board-card-line">
              {order ? nameOf(order.customerId) : short(row.orderId)}
            </span>
            <span className="board-card-line">{money(row.value.amount, row.value.currency)}</span>
            <span className="board-card-line">
              {t('itemsCount', { count: row.lines.length })}
              {row.carrier ? ` · ${row.carrier}` : ''}
            </span>
          </BoardCard>
        )
      }}
      rows={rows}
    />
  )
}

/** Every offer held back by a discount somebody else has to allow, oldest first. */
function Inbox({
  rows,
  data,
  onOpen,
}: {
  rows: readonly Quote[]
  data: SalesScreenData
  onOpen: (row: Quote) => void
}) {
  const t = useTranslations('sales')
  const label = useStatusLabel()
  const money = useMoney()
  const nameOf = customerNames(data)
  if (rows.length === 0)
    return (
      <div className="panel catalog-empty">
        <strong>{t('inboxEmpty')}</strong>
        <p>{t('inboxEmptyCopy')}</p>
      </div>
    )
  return (
    <div className="panel table-panel">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('document')}</th>
              <th>{t('customer')}</th>
              <th>{t('askedBy')}</th>
              <th className="numeric">{t('discount')}</th>
              <th className="numeric">{t('total')}</th>
              <th aria-label={t('decide')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <code>{reference('QT', row.rootId)}</code>{' '}
                  <Badge label={label(row.approvalState)} status={row.approvalState} />
                </td>
                <td>{nameOf(row.customerId)}</td>
                <td>{row.approvalRequestedBy ?? '—'}</td>
                <td className="numeric">{money(row.discount, row.currency)}</td>
                <td className="numeric">{money(row.total, row.currency)}</td>
                <td>
                  <Button onClick={() => onOpen(row)} type="button" variant="secondary">
                    {t('decide')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
