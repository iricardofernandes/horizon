'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useStatusLabel } from '@/lib/status'
import type { SectionProps } from './title-detail-dialog'
import { ReasonForm } from './title-forms'
import { namespaceOf } from './types'

/**
 * Four eyes on money leaving the company: an operator asks, someone else decides. The
 * section only offers what the session may do; Financial refuses the rest (ADR 0045).
 */
export function ApprovalSection({
  direction,
  detail,
  abilities,
  busy,
  command,
  setNotice,
  required,
}: SectionProps & { required: boolean }) {
  const t = useTranslations(namespaceOf(direction))
  const statusLabel = useStatusLabel()
  const [rejecting, setRejecting] = useState(false)
  const state = detail.approvalState
  const plain = { idempotent: false }
  if (!required && state === 'none') return null
  const ownRequest =
    detail.approvalRequestedBy !== null && detail.approvalRequestedBy === abilities.userId
  const canRequest = abilities.canRecord && (state === 'none' || state === 'rejected')
  const canDecide = abilities.canApprove && state === 'pending' && !ownRequest

  return (
    <section className="receivable-section title-approval">
      <div className="title-approval-heading">
        <h3>{t('approval')}</h3>
        <Badge label={statusLabel(approvalBadge(state))} status={approvalBadge(state)} />
      </div>
      {detail.approvalReason ? <p className="catalog-page-copy">{detail.approvalReason}</p> : null}
      {state === 'pending' && ownRequest ? (
        <p className="catalog-page-copy">{t('awaitingOtherApprover')}</p>
      ) : null}
      <div className="receivable-actions">
        {canRequest ? (
          <Button
            disabled={busy}
            onClick={async () => {
              if (
                await command(
                  `financial.${direction}.request-approval`,
                  '/approval-request',
                  {},
                  plain,
                )
              )
                setNotice(t('approvalRequested'))
            }}
            type="button"
            variant="primary"
          >
            {t('requestApproval')}
          </Button>
        ) : null}
        {canDecide && !rejecting ? (
          <>
            <Button
              disabled={busy}
              onClick={async () => {
                if (await command(`financial.${direction}.approve`, '/approve', {}, plain))
                  setNotice(t('approved'))
              }}
              type="button"
              variant="primary"
            >
              {t('approve')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => setRejecting(true)}
              type="button"
              variant="danger"
            >
              {t('reject')}
            </Button>
          </>
        ) : null}
        {rejecting ? (
          <ReasonForm
            busy={busy}
            direction={direction}
            onCancel={() => setRejecting(false)}
            onSubmit={async (reason) => {
              if (await command(`financial.${direction}.reject`, '/reject', { reason }, plain)) {
                setRejecting(false)
                setNotice(t('rejected'))
              }
            }}
            submitLabel={t('reject')}
          />
        ) : null}
      </div>
    </section>
  )
}

/** "none" reads as "not requested yet" beside a title that needs approval. */
function approvalBadge(state: string): string {
  return state === 'none'
    ? 'approval-not-requested'
    : state === 'pending'
      ? 'awaiting-approval'
      : state
}
