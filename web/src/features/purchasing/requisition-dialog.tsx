'use client'

import { Dialog } from '@base-ui/react/dialog'
import { X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingState, Notice } from '@/components/ui/state'
import { apiError, readJson } from '@/lib/api'
import { idempotentJsonHeaders, jsonHeaders } from '@/lib/http'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import { useDate, useMoney } from '@/lib/use-format'
import {
  type Comparison,
  PROCUREMENT_API,
  type PurchasingAbilities,
  type RequisitionDetail,
  type RequisitionRow,
} from './types'

/**
 * One need, what it asked for, and what suppliers answered.
 *
 * The comparison is the point of the screen: the offers sit under the line they are for, so
 * a buyer reads across a row rather than between two documents. The cheapest unit price is
 * marked by the API, not here, so the table and whoever reads the API agree about it.
 */
export function RequisitionDialog({
  requisition,
  abilities,
  onClose,
  onChanged,
}: {
  requisition: RequisitionRow
  abilities: PurchasingAbilities
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('purchasing')
  const common = useTranslations('common')
  const [detail, setDetail] = useState<RequisitionDetail | null>(null)
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const [loaded, offers] = await Promise.all([
        readJson<RequisitionDetail>(
          'procurement.requisition',
          `${PROCUREMENT_API}/requisitions/${requisition.id}`,
        ),
        readJson<Comparison>(
          'procurement.comparison',
          `${PROCUREMENT_API}/requisitions/${requisition.id}/comparison`,
        ),
      ])
      setDetail(loaded)
      setComparison(offers)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [requisition.id])

  useEffect(() => {
    void load()
  }, [load])

  const command = async (name: string, path: string, body?: unknown): Promise<void> => {
    setBusy(true)
    setError('')
    const response = await tracedFetch(name, path, {
      method: 'POST',
      headers: body === undefined ? jsonHeaders() : jsonHeaders(),
      body: JSON.stringify(body ?? {}),
    })
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('actionFailed')))
      return
    }
    await Promise.all([load(), onChanged()])
  }

  const order = async (quotationId: string): Promise<void> => {
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      'procurement.order.fromQuotation',
      `${PROCUREMENT_API}/orders/from-quotation`,
      {
        method: 'POST',
        headers: idempotentJsonHeaders(),
        body: JSON.stringify({ quotationId, issuedOn: new Date().toISOString().slice(0, 10) }),
      },
    )
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('actionFailed')))
      return
    }
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
          {detail && comparison ? (
            <Body
              abilities={abilities}
              busy={busy}
              comparison={comparison}
              detail={detail}
              error={error}
              onDecide={command}
              onOrder={order}
            />
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Body({
  detail,
  comparison,
  abilities,
  busy,
  error,
  onDecide,
  onOrder,
}: {
  detail: RequisitionDetail
  comparison: Comparison
  abilities: PurchasingAbilities
  busy: boolean
  error: string
  onDecide: (name: string, path: string, body?: unknown) => Promise<void>
  onOrder: (quotationId: string) => Promise<void>
}) {
  const t = useTranslations('purchasing')
  const label = useStatusLabel()
  const date = useDate()
  const money = useMoney()
  const [reason, setReason] = useState('')
  const base = `${PROCUREMENT_API}/requisitions/${detail.id}`
  // Four eyes: whoever submitted it is never offered the decision on it.
  const decidable =
    detail.status === 'submitted' && abilities.canDecide && detail.submittedBy !== abilities.userId
  const selected = comparison.quotations.find((one) => one.status === 'selected')

  return (
    <>
      <div className="dialog-heading">
        <Dialog.Title>
          {t('requisitionTitle', { id: detail.id.slice(-8).toUpperCase() })}
        </Dialog.Title>
        <Badge label={label(detail.status)} status={detail.status} />
      </div>
      <dl className="document-facts">
        <div>
          <dt>{t('requestedBy')}</dt>
          <dd>{detail.requestedBy}</dd>
        </div>
        <div>
          <dt>{t('neededBy')}</dt>
          <dd>{date(detail.neededBy)}</dd>
        </div>
        <div>
          <dt>{t('decidedBy')}</dt>
          <dd>{detail.decidedBy ?? '—'}</dd>
        </div>
      </dl>
      {detail.justification ? <p className="document-note">{detail.justification}</p> : null}
      {detail.decisionReason ? (
        <p className="document-note">{t('reasonGiven', { reason: detail.decisionReason })}</p>
      ) : null}

      <h3 className="document-section-title">{t('comparison')}</h3>
      {comparison.quotations.length === 0 ? (
        <p className="document-note">{t('noQuotations')}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('line')}</th>
                <th className="numeric">{t('quantity')}</th>
                {comparison.quotations.map((quotation) => (
                  <th className="numeric" key={quotation.id}>
                    {quotation.supplierName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparison.lines.map((line) => (
                <tr key={line.lineId}>
                  <td>{line.description}</td>
                  <td className="numeric">{line.quantity}</td>
                  {comparison.quotations.map((quotation) => {
                    const offer = line.offers.find((one) => one.quotationId === quotation.id)
                    return (
                      <td className="numeric" key={quotation.id}>
                        {offer ? (
                          <span className={offer.best ? 'purchasing-best' : undefined}>
                            {money(offer.unitPrice, quotation.currency)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={2}>{t('total')}</th>
                {comparison.quotations.map((quotation) => (
                  <td className="numeric" key={quotation.id}>
                    {money(quotation.total, quotation.currency)}
                  </td>
                ))}
              </tr>
              <tr>
                <th colSpan={2}>{t('leadTime')}</th>
                {comparison.quotations.map((quotation) => (
                  <td className="numeric" key={quotation.id}>
                    {t('days', { days: quotation.leadTimeDays })}
                  </td>
                ))}
              </tr>
              <tr>
                <th colSpan={2}>{t('offer')}</th>
                {comparison.quotations.map((quotation) => (
                  <td key={quotation.id}>
                    {quotation.status === 'selected' ? (
                      <Badge label={label('selected')} status="selected" />
                    ) : abilities.canCommit && detail.status === 'approved' && !selected ? (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          onDecide(
                            'procurement.quotation.select',
                            `${PROCUREMENT_API}/quotations/${quotation.id}/select`,
                          )
                        }
                        type="button"
                        variant="secondary"
                      >
                        {t('choose')}
                      </Button>
                    ) : (
                      <Badge label={label(quotation.status)} status={quotation.status} />
                    )}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {error ? <Notice copy={error} /> : null}

      <div className="dialog-actions">
        {detail.status === 'draft' && abilities.canWrite ? (
          <Button
            disabled={busy}
            onClick={() => onDecide('procurement.requisition.submit', `${base}/submit`)}
            type="button"
          >
            {t('submit')}
          </Button>
        ) : null}
        {decidable ? (
          <>
            <label className="document-reason">
              <span className="ledger-field-label">{t('reason')}</span>
              <input
                className="ui-input"
                onChange={(event) => setReason(event.target.value)}
                value={reason}
              />
            </label>
            <Button
              disabled={busy || reason.trim().length < 3}
              onClick={() =>
                onDecide('procurement.requisition.reject', `${base}/reject`, { reason })
              }
              type="button"
              variant="secondary"
            >
              {t('reject')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => onDecide('procurement.requisition.approve', `${base}/approve`)}
              type="button"
            >
              {t('approve')}
            </Button>
          </>
        ) : null}
        {selected && detail.status === 'approved' && abilities.canWrite ? (
          <Button disabled={busy} onClick={() => onOrder(selected.id)} type="button">
            {t('writeOrder')}
          </Button>
        ) : null}
      </div>
    </>
  )
}
