'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useStatusLabel } from '@/lib/status'
import { useDate, useMoney } from '@/lib/use-format'
import { OrderDialog } from './order-dialog'
import { BoardCard, PurchasingBoard } from './purchasing-board'
import { RequisitionDialog } from './requisition-dialog'
import {
  awaitingDecision,
  ORDER_COLUMNS,
  type OrderRow,
  type PurchasingAbilities,
  type PurchasingData,
  REQUISITION_COLUMNS,
  type RequisitionRow,
} from './types'

export type Screen = 'requisitions' | 'orders' | 'approvals'

/**
 * Purchasing, as three ways of looking at the same work: what has been asked for, what has
 * been committed to, and what is waiting for somebody to decide.
 *
 * The inbox is deliberately not a fourth kind of document. It is the same requisitions and
 * orders, filtered to the ones whose next step is a decision — so approving something there
 * and finding it on its board afterwards is the same object, not a copy of it.
 */
export function PurchasingView({
  screen,
  data,
  abilities,
  onChanged,
}: {
  screen: Screen
  data: PurchasingData
  abilities: PurchasingAbilities
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('purchasing')
  const [requisition, setRequisition] = useState<RequisitionRow | null>(null)
  const [order, setOrder] = useState<OrderRow | null>(null)
  const waiting = awaitingDecision(data, abilities.userId)

  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t(`${screen}.title`)}</h1>
        <p className="catalog-page-copy">{t(`${screen}.copy`)}</p>
      </header>

      {screen === 'requisitions' ? (
        <RequisitionsBoard onOpen={setRequisition} rows={data.requisitions} />
      ) : null}
      {screen === 'orders' ? <OrdersBoard onOpen={setOrder} rows={data.orders} /> : null}
      {screen === 'approvals' ? (
        <Inbox
          onOpenOrder={setOrder}
          onOpenRequisition={setRequisition}
          orders={waiting.orders}
          requisitions={waiting.requisitions}
        />
      ) : null}

      {requisition ? (
        <RequisitionDialog
          abilities={abilities}
          onChanged={onChanged}
          onClose={() => setRequisition(null)}
          requisition={requisition}
        />
      ) : null}
      {order ? (
        <OrderDialog
          abilities={abilities}
          onChanged={onChanged}
          onClose={() => setOrder(null)}
          order={order}
        />
      ) : null}
    </section>
  )
}

function RequisitionsBoard({
  rows,
  onOpen,
}: {
  rows: readonly RequisitionRow[]
  onOpen: (row: RequisitionRow) => void
}) {
  const t = useTranslations('purchasing')
  const date = useDate()
  return (
    <PurchasingBoard
      columnOf={(row) => row.status}
      columns={REQUISITION_COLUMNS}
      keyOf={(row) => row.id}
      renderCard={(row) => (
        <BoardCard
          label={t('openRequisition', { id: row.id.slice(-8).toUpperCase() })}
          onOpen={() => onOpen(row)}
          title={`RQ-${row.id.slice(-8).toUpperCase()}`}
        >
          <span className="board-card-line">{t('neededOn', { date: date(row.neededBy) })}</span>
          <span className="board-card-line">
            {t('linesCount', { count: row.lines })} · {t('offersCount', { count: row.quotations })}
          </span>
          <span className="board-card-line">{row.requestedBy}</span>
        </BoardCard>
      )}
      rows={rows}
    />
  )
}

function OrdersBoard({
  rows,
  onOpen,
}: {
  rows: readonly OrderRow[]
  onOpen: (row: OrderRow) => void
}) {
  const t = useTranslations('purchasing')
  const money = useMoney()
  const date = useDate()
  return (
    <PurchasingBoard
      columnOf={(row) => row.status}
      columns={ORDER_COLUMNS}
      keyOf={(row) => row.id}
      renderCard={(row) => (
        <BoardCard
          label={t('openOrder', { id: row.id.slice(-8).toUpperCase() })}
          onOpen={() => onOpen(row)}
          title={`PO-${row.id.slice(-8).toUpperCase()}`}
        >
          <span className="board-card-line">{row.supplierName}</span>
          <span className="board-card-line">{money(row.total, row.currency)}</span>
          <span className="board-card-line">
            {t('expectedOnDate', { date: date(row.expectedOn) })}
            {row.receipts > 0 ? ` · ${t('deliveriesCount', { count: row.receipts })}` : ''}
          </span>
        </BoardCard>
      )}
      rows={rows}
    />
  )
}

/** Everything whose next step is somebody's decision, oldest first. */
function Inbox({
  requisitions,
  orders,
  onOpenRequisition,
  onOpenOrder,
}: {
  requisitions: readonly RequisitionRow[]
  orders: readonly OrderRow[]
  onOpenRequisition: (row: RequisitionRow) => void
  onOpenOrder: (row: OrderRow) => void
}) {
  const t = useTranslations('purchasing')
  const label = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  if (requisitions.length === 0 && orders.length === 0)
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
              <th>{t('what')}</th>
              <th>{t('askedBy')}</th>
              <th className="numeric">{t('value')}</th>
              <th aria-label={t('decide')} />
            </tr>
          </thead>
          <tbody>
            {requisitions.map((row) => (
              <tr key={row.id}>
                <td>
                  <code>RQ-{row.id.slice(-8).toUpperCase()}</code>
                </td>
                <td>{t('neededOn', { date: date(row.neededBy) })}</td>
                <td>{row.submittedBy ?? row.requestedBy}</td>
                <td className="numeric">—</td>
                <td>
                  <Button onClick={() => onOpenRequisition(row)} type="button" variant="secondary">
                    {t('decide')}
                  </Button>
                </td>
              </tr>
            ))}
            {orders.map((row) => (
              <tr key={row.id}>
                <td>
                  <code>PO-{row.id.slice(-8).toUpperCase()}</code>
                </td>
                <td>
                  {row.supplierName} <Badge label={label(row.status)} status={row.status} />
                </td>
                <td>{row.approvalRequestedBy ?? '—'}</td>
                <td className="numeric">{money(row.total, row.currency)}</td>
                <td>
                  <Button onClick={() => onOpenOrder(row)} type="button" variant="secondary">
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
