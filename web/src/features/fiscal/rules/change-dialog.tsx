'use client'

import { Dialog } from '@base-ui/react/dialog'
import { X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { useSession } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingState, Notice } from '@/components/ui/state'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime } from '@/lib/use-format'
import { fiscalCommand } from '../client'
import { FISCAL_API } from '../types'
import { DiffView, ImpactView } from './diff-view'
import { changeActions, type RuleAbilities, type RuleChange } from './types'

export const STATUS_TONE = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'draft',
} as const

/**
 * One rule change: what was asked, what it does to the rules and to the locked documents, and
 * how it was decided. Whoever asked never sees the approval (ADR 0062); Fiscal refuses it too.
 */
export function ChangeDialog({
  changeId,
  abilities,
  onClose,
  onChanged,
}: {
  changeId: string
  abilities: RuleAbilities
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('fiscal.rules')
  const common = useTranslations('common')
  const session = useSession()
  const [change, setChange] = useState<RuleChange | null>(null)
  const [failed, setFailed] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const response = await tracedFetch(
      'fiscal.rule-change',
      `${FISCAL_API}/rule-changes/${changeId}`,
      {
        cache: 'no-store',
      },
    )
    if (!response.ok) return setFailed(true)
    setChange((await response.json()) as RuleChange)
  }, [changeId])

  useEffect(() => {
    void load()
  }, [load])

  async function act(action: 'approve' | 'reject' | 'cancel') {
    setBusy(true)
    setError('')
    const outcome = await fiscalCommand(
      `fiscal.rule-change.${action}`,
      `/rule-changes/${changeId}/${action}`,
      reason.trim() ? { reason: reason.trim() } : {},
    )
    setBusy(false)
    if (!outcome.ok) return setError(outcome.detail ?? t('actionFailed'))
    await Promise.all([load(), onChanged()])
  }

  const actions = change ? changeActions(change, abilities, session?.id ?? null) : null
  return (
    <Dialog.Root onOpenChange={(open) => (open ? undefined : onClose())} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup document-dialog">
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {failed ? <Notice copy={t('changeUnavailable')} /> : null}
          {!failed && !change ? <LoadingState /> : null}
          {change ? (
            <>
              <Dialog.Title>{t(`kinds.${change.kind}`)}</Dialog.Title>
              <ChangeFacts change={change} />
              <h3 className="document-section-title">{t('diffTitle')}</h3>
              <DiffView diff={change.diff} />
              <h3 className="document-section-title">{t('impactTitle')}</h3>
              <ImpactView impact={change.impact} />
              {actions?.decide || actions?.cancel ? (
                <ChangeActions
                  act={act}
                  busy={busy}
                  cancel={actions.cancel}
                  decide={actions.decide}
                  onReason={setReason}
                  reason={reason}
                />
              ) : null}
              {change.status === 'pending' && !actions?.decide && abilities.canDecide ? (
                <p className="document-note">{t('ownRequest')}</p>
              ) : null}
              {error ? <Notice copy={error} /> : null}
            </>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ChangeFacts({ change }: { change: RuleChange }) {
  const t = useTranslations('fiscal.rules')
  const dateTime = useDateTime()
  return (
    <dl className="document-facts">
      <div>
        <dt>{t('status')}</dt>
        <dd>
          <Badge label={t(`statuses.${change.status}`)} status={STATUS_TONE[change.status]} />
        </dd>
      </div>
      <div>
        <dt>{t('requestedBy')}</dt>
        <dd>
          {change.requestedBy} · {dateTime(change.requestedAt)}
        </dd>
      </div>
      <div>
        <dt>{t('reason')}</dt>
        <dd>{String(change.request.reason ?? '')}</dd>
      </div>
      {change.decision ? (
        <div>
          <dt>{t('decidedBy')}</dt>
          <dd>
            {change.decision.onBehalfOf
              ? t('decidedOnBehalf', {
                  actor: change.decision.decidedBy,
                  delegator: change.decision.onBehalfOf,
                })
              : change.decision.decidedBy}{' '}
            · {dateTime(change.decision.decidedAt)}
            {change.decision.reason ? ` — ${change.decision.reason}` : ''}
          </dd>
        </div>
      ) : null}
    </dl>
  )
}

/** Approve and reject for a decider; cancel for the requester; never both (ADR 0062). */
function ChangeActions({
  decide,
  cancel,
  busy,
  reason,
  onReason,
  act,
}: {
  decide: boolean
  cancel: boolean
  busy: boolean
  reason: string
  onReason: (value: string) => void
  act: (action: 'approve' | 'reject' | 'cancel') => Promise<void>
}) {
  const t = useTranslations('fiscal.rules')
  return (
    <div className="dialog-actions">
      <label className="ui-field">
        <span className="ui-field-label">{t('decisionReason')}</span>
        <textarea
          className="ui-input"
          maxLength={1000}
          onChange={(event) => onReason(event.target.value)}
          rows={2}
          value={reason}
        />
      </label>
      {decide ? (
        <>
          <Button disabled={busy} onClick={() => void act('approve')}>
            {t('approve')}
          </Button>
          <Button disabled={busy} onClick={() => void act('reject')} variant="secondary">
            {t('reject')}
          </Button>
        </>
      ) : null}
      {cancel ? (
        <Button disabled={busy} onClick={() => void act('cancel')} variant="secondary">
          {t('cancel')}
        </Button>
      ) : null}
    </div>
  )
}
