'use client'

import { Dialog } from '@base-ui/react/dialog'
import { DownloadSimple, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { LoadingState, Notice } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { short } from '@/lib/format'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime } from '@/lib/use-format'
import { fiscalCommand } from './client'
import { FISCAL_API, type ImportDetail, reconciliationFromProposals } from './types'

/**
 * One supplier NF-e under review: its verified lines, the receipts Fiscal proposes, and the
 * conflicts that block it. Confirming the proposal is a person's decision (ADR 0046).
 */
export function ImportDialog({
  importId,
  onClose,
  onChanged,
}: {
  importId: string
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('fiscal')
  const common = useTranslations('common')
  const dateTime = useDateTime()
  const [detail, setDetail] = useState<ImportDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    const response = await tracedFetch('fiscal.import.read', `${FISCAL_API}/imports/${importId}`, {
      cache: 'no-store',
    })
    setDetail(response.ok ? ((await response.json()) as ImportDetail) : null)
    setLoading(false)
  }, [importId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function command(name: string, path: string, body: unknown, done: string) {
    setBusy(true)
    setError('')
    setNotice('')
    const outcome = await fiscalCommand(name, path, body)
    setBusy(false)
    if (!outcome.ok) {
      setError(
        t('actions.refused', {
          code: outcome.code ?? String(outcome.status),
          detail: outcome.detail ?? t('actions.noDetail'),
        }),
      )
      return
    }
    setNotice(done)
    await refresh()
    await onChanged()
  }

  function reconcile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!detail) return
    const data = new FormData(event.currentTarget)
    const supplier = String(data.get('supplierPartyId') ?? '')
    if (!supplier) {
      setError(t('inbound.noSupplier'))
      return
    }
    void command(
      'fiscal.import.reconcile',
      `/imports/${importId}/reconciliation`,
      reconciliationFromProposals(detail, supplier, String(data.get('overrideReason') ?? '')),
      t('inbound.reconciled'),
    )
  }

  return (
    <Dialog.Root onOpenChange={(open) => !open && onClose()} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup order-detail-dialog fiscal-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{t('inbound.dialogTitle')}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('inbound.dialogDescription', { id: short(importId) })}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {loading ? (
            <LoadingState />
          ) : !detail ? (
            <Notice copy={t('inbound.unavailable')} />
          ) : (
            <>
              <ImportSummaryPanel detail={detail} />
              <ImportLines detail={detail} />
              {detail.conflicts
                .filter((conflict) => !conflict.dismissed)
                .map((conflict) => (
                  <ConflictForm
                    busy={busy}
                    conflict={conflict}
                    key={conflict.id}
                    onDismiss={(reason) =>
                      command(
                        'fiscal.import.dismiss-conflict',
                        `/imports/${importId}/conflict-dismissals`,
                        { conflictId: conflict.id, reason },
                        t('inbound.conflictDismissed'),
                      )
                    }
                  />
                ))}
              {detail.reconciliation ? (
                <p role="status">
                  {t('inbound.reconciledBy', {
                    decision: t(`inbound.decisions.${detail.reconciliation.decision}`),
                    by: detail.reconciliation.reviewedBy,
                    at: dateTime(detail.reconciliation.reviewedAt),
                    payables: detail.reconciliation.payableTitleIds.length,
                  })}
                </p>
              ) : (
                <form className="dialog-form" onSubmit={reconcile}>
                  <SelectField
                    label={t('inbound.supplierParty')}
                    name="supplierPartyId"
                    options={detail.supplier.candidatePartyIds.map((id) => ({
                      value: id,
                      label: short(id),
                    }))}
                    placeholder={t('inbound.noCandidate')}
                  />
                  <TextField
                    description={t('inbound.overrideHint')}
                    label={t('inbound.overrideReason')}
                    name="overrideReason"
                  />
                  <Button
                    disabled={busy || !detail.supplier.candidatePartyIds.length}
                    type="submit"
                    variant="primary"
                  >
                    {t('inbound.confirmProposal')}
                  </Button>
                </form>
              )}
              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
              {notice ? <p role="status">{notice}</p> : null}
              <div className="dialog-actions">
                <a
                  className="ui-button ui-button-ghost"
                  download
                  href={`${FISCAL_API}/imports/${importId}/xml`}
                >
                  <DownloadSimple aria-hidden="true" size={15} /> {t('inbound.downloadXml')}
                </a>
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ImportSummaryPanel({ detail }: { detail: ImportDetail }) {
  const t = useTranslations('fiscal')
  return (
    <>
      <div className="delivery-summary">
        <div>
          <span className="summary-label">{t('inbound.supplier')}</span>
          <strong>
            {detail.supplier.legalName} ({detail.supplier.uf})
          </strong>
        </div>
        <div>
          <span className="summary-label">{t('inbound.status')}</span>
          <Badge
            label={t(`inbound.statuses.${detail.status}`)}
            status={detail.status === 'reconciled' ? 'approved' : 'pending'}
          />
        </div>
        <div>
          <span className="summary-label">{t('inbound.total')}</span>
          <strong>{detail.invoiceTotal}</strong>
        </div>
      </div>
      <Notice copy={t('inbound.evidenceOnly')} />
    </>
  )
}

function ImportLines({ detail }: { detail: ImportDetail }) {
  const t = useTranslations('fiscal')
  const proposalText = (lineNumber: number) => {
    const proposal = detail.proposals.find((row) => row.lineNumber === lineNumber)
    return proposal?.allocations.length
      ? t('inbound.proposed', {
          basis: t(`inbound.basis.${proposal.basis}`),
          count: proposal.allocations.length,
        })
      : t('inbound.unmatched')
  }
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t('inbound.line')}</th>
            <th>{t('inbound.product')}</th>
            <th>{t('inbound.quantity')}</th>
            <th>{t('inbound.lineTotal')}</th>
            <th>{t('inbound.proposal')}</th>
          </tr>
        </thead>
        <tbody>
          {detail.lines.map((line) => (
            <tr key={line.number}>
              <td>{line.number}</td>
              <td>
                {line.productCode} · {line.description}
              </td>
              <td>
                {line.quantity} {line.unit}
              </td>
              <td>{line.gross}</td>
              <td>{proposalText(line.number)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ConflictForm({
  conflict,
  busy,
  onDismiss,
}: {
  conflict: ImportDetail['conflicts'][number]
  busy: boolean
  onDismiss: (reason: string) => Promise<void>
}) {
  const t = useTranslations('fiscal')
  const dateTime = useDateTime()
  return (
    <form
      className="dialog-form fiscal-conflict"
      onSubmit={(event) => {
        event.preventDefault()
        void onDismiss(String(new FormData(event.currentTarget).get('reason') ?? ''))
      }}
    >
      <p role="alert">
        {t('inbound.conflict', {
          digest: conflict.sourceDigest.slice(0, 12),
          at: dateTime(conflict.receivedAt),
        })}
      </p>
      <TextField label={t('inbound.dismissReason')} minLength={10} name="reason" required />
      <Button disabled={busy} type="submit" variant="secondary">
        {t('inbound.dismiss')}
      </Button>
    </form>
  )
}
