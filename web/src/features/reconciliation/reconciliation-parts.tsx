'use client'

import { Dialog } from '@base-ui/react/dialog'
import { FileArrowUp, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { localToday } from '@/features/titles/types'
import { apiError } from '@/lib/api'
import { idempotentJsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { useDate, useMoney } from '@/lib/use-format'
import { post, TREASURY_API } from './commands'
import {
  formatOf,
  type Metrics,
  type ReconciliationAbilities,
  type Suggestion,
  type SuggestionReason,
  type Workspace,
} from './types'

const CURRENCY = 'BRL'
type Done = (notice: string) => Promise<void>

export function SummaryCards({
  workspace,
  metrics,
}: {
  workspace: Workspace
  metrics: Metrics | null
}) {
  const t = useTranslations('reconciliation')
  const money = useMoney()
  const { summary } = workspace
  const cards: [string, string][] = [
    [t('statementTotal'), summary.statementTotal],
    [t('unmatchedStatement'), summary.unmatchedStatement],
    [t('unmatchedEntries'), summary.unmatchedEntries],
    [t('periodDifference'), summary.difference],
  ]
  return (
    <div className="receivables-summary">
      {cards.map(([label, amount]) => (
        <article className="customer-summary-card" key={label}>
          <span>{label}</span>
          <strong>{money(amount, CURRENCY)}</strong>
        </article>
      ))}
      <p className="treasury-account-note reconciliation-note">
        {t('bookRange', {
          opening: money(summary.bookOpening, CURRENCY),
          closing: money(summary.bookClosing, CURRENCY),
        })}{' '}
        {metrics?.acceptanceRate !== null && metrics?.acceptanceRate !== undefined
          ? t('acceptance', { percent: Math.round(metrics.acceptanceRate * 100) })
          : ''}
      </p>
    </div>
  )
}

function useReasonText() {
  const t = useTranslations('reconciliation')
  return (reason: SuggestionReason) => {
    switch (reason.code) {
      case 'amount-sum':
        return t('reasons.amount-sum', { parts: reason.parts })
      case 'date':
        return t('reasons.date', { days: reason.days })
      case 'document':
        return t('reasons.document', { document: reason.document })
      case 'counterparty':
        return t('reasons.counterparty', { percent: reason.percent })
      case 'text':
        return t('reasons.text', { percent: reason.percent })
      default:
        return t('reasons.amount-exact')
    }
  }
}

/** What the matcher proposes and why. Nothing here is confirmed until a person accepts it. */
export function SuggestionsPanel({
  accountId,
  workspace,
  abilities,
  onDone,
}: {
  accountId: string
  workspace: Workspace
  abilities: ReconciliationAbilities
  onDone: Done
}) {
  const t = useTranslations('reconciliation')
  const money = useMoney()
  const reasonText = useReasonText()
  const [error, setError] = useState('')
  const describe = (suggestion: Suggestion) => ({
    bank: workspace.lines.filter((line) => suggestion.statementLineIds.includes(line.id)),
    books: workspace.entries.filter((entry) => suggestion.entryIds.includes(entry.id)),
  })
  if (!workspace.suggestions.length) return null

  const act = async (refusal: Promise<string | null>, notice: string) => {
    setError('')
    const refused = await refusal
    if (refused) setError(refused)
    else await onDone(notice)
  }

  return (
    <section className="panel reconciliation-suggestions" aria-label={t('suggestions')}>
      <h2>{t('suggestions')}</h2>
      <p className="treasury-account-note">{t('suggestionsCopy')}</p>
      <ul>
        {workspace.suggestions.map((suggestion) => {
          const { bank, books } = describe(suggestion)
          return (
            <li key={suggestion.key}>
              <div className="reconciliation-suggestion-heading">
                <Badge
                  label={t('score', { score: suggestion.score })}
                  status="reconciliation-score"
                />
                <strong>
                  {bank
                    .map((line) => `${line.description} ${money(line.open, CURRENCY)}`)
                    .join(' + ')}
                  {' ⇄ '}
                  {books
                    .map(
                      (entry) =>
                        `${entry.memo ?? entry.counterparty ?? t(`sources.${entry.source}`)} ${money(entry.open, CURRENCY)}`,
                    )
                    .join(' + ')}
                </strong>
              </div>
              <small>{suggestion.reasons.map(reasonText).join(' · ')}</small>
              {abilities.canRecord ? (
                <div className="receivable-actions">
                  <Button
                    aria-label={t('acceptLabel', { description: bank[0]?.description ?? '' })}
                    onClick={() =>
                      act(
                        post(
                          'treasury.reconciliation.accept',
                          `/accounts/${accountId}/reconciliations`,
                          {
                            statementLines: suggestion.statementLineIds.map((id) => ({ id })),
                            entries: suggestion.entryIds.map((id) => ({ id })),
                            suggestionKey: suggestion.key,
                          },
                          t('actionFailed'),
                        ),
                        t('matched'),
                      )
                    }
                    type="button"
                    variant="secondary"
                  >
                    {t('accept')}
                  </Button>
                  <Button
                    onClick={() =>
                      act(
                        post(
                          'treasury.suggestion.dismiss',
                          `/accounts/${accountId}/suggestions/dismiss`,
                          { key: suggestion.key, score: suggestion.score },
                          t('actionFailed'),
                          { idempotent: false },
                        ),
                        t('dismissed'),
                      )
                    }
                    type="button"
                    variant="ghost"
                  >
                    {t('dismiss')}
                  </Button>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

export function HistoryPanel({
  workspace,
  abilities,
  onDone,
}: {
  workspace: Workspace
  abilities: ReconciliationAbilities
  onDone: Done
}) {
  const t = useTranslations('reconciliation')
  const [undoing, setUndoing] = useState<string | null>(null)
  const [error, setError] = useState('')
  if (!workspace.reconciliations.length) return null

  async function undo(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault()
    setError('')
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '')
    const refused = await post(
      'treasury.reconciliation.undo',
      `/reconciliations/${id}/undo`,
      { reason },
      t('actionFailed'),
    )
    if (refused) setError(refused)
    else {
      setUndoing(null)
      await onDone(t('undone'))
    }
  }

  return (
    <section className="panel treasury-transfers">
      <h2>{t('history')}</h2>
      <ul className="reconciliation-history">
        {workspace.reconciliations.map((record) => (
          <HistoryItem
            canUndo={abilities.canUndo}
            key={record.id}
            onCancel={() => setUndoing(null)}
            onStart={() => setUndoing(record.id)}
            onUndo={(event) => undo(event, record.id)}
            record={record}
            undoing={undoing === record.id}
          />
        ))}
      </ul>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

function HistoryItem({
  record,
  canUndo,
  undoing,
  onStart,
  onCancel,
  onUndo,
}: {
  record: Workspace['reconciliations'][number]
  canUndo: boolean
  undoing: boolean
  onStart: () => void
  onCancel: () => void
  onUndo: (event: FormEvent<HTMLFormElement>) => void
}) {
  const t = useTranslations('reconciliation')
  const date = useDate()
  const details = [
    t('historyLine', {
      lines: record.items.filter((item) => item.kind === 'statement').length,
      entries: record.items.filter((item) => item.kind === 'entry').length,
      date: date(record.confirmedAt),
    }),
    record.origin === 'suggestion'
      ? t(record.corrected ? 'fromSuggestionCorrected' : 'fromSuggestion')
      : null,
    record.reason,
    record.status === 'undone' ? t('undoneWith', { reason: record.undoReason ?? '' }) : null,
  ]
  return (
    <li>
      <div>
        <Badge
          label={t(`kinds.${record.kind}`)}
          status={record.status === 'undone' ? 'reversed' : 'posted'}
        />
        <span>{details.filter(Boolean).join(' · ')}</span>
      </div>
      {canUndo && record.status === 'active' && !undoing ? (
        <Button onClick={onStart} type="button" variant="ghost">
          {t('undo')}
        </Button>
      ) : null}
      {undoing ? (
        <form className="receivable-inline-form" onSubmit={onUndo}>
          <TextField label={t('reason')} maxLength={500} minLength={3} name="reason" required />
          <div className="dialog-actions">
            <Button onClick={onCancel} type="button" variant="secondary">
              {t('keep')}
            </Button>
            <Button type="submit" variant="danger">
              {t('undo')}
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  )
}

export function ImportDialog({ accountId, onDone }: { accountId: string; onDone: Done }) {
  const t = useTranslations('reconciliation')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const file = new FormData(event.currentTarget).get('file')
    if (!(file instanceof File) || file.size === 0) {
      setError(t('chooseFile'))
      return
    }
    setBusy(true)
    const response = await tracedFetch(
      'treasury.statement.import',
      `${TREASURY_API}/accounts/${accountId}/statements`,
      {
        method: 'POST',
        headers: idempotentJsonHeaders(),
        body: JSON.stringify({
          format: formatOf(file.name),
          fileName: file.name,
          content: await file.text(),
        }),
      },
    )
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('importFailed')))
      return
    }
    const outcome = (await response.json()) as { imported: number; duplicates: number }
    setOpen(false)
    await onDone(t('imported', { imported: outcome.imported, duplicates: outcome.duplicates }))
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-secondary">
        <FileArrowUp aria-hidden="true" size={17} />
        {t('importStatement')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <div className="dialog-heading">
            <Dialog.Title>{t('importStatement')}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('importDescription')}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <form className="dialog-form" onSubmit={submit}>
            <label className="ui-field">
              <span className="ui-field-label">{t('file')}</span>
              <input
                accept=".ofx,.csv,.txt"
                className="ui-input"
                name="file"
                required
                type="file"
              />
            </label>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <Dialog.Close className="ui-button ui-button-secondary">
                {common('cancel')}
              </Dialog.Close>
              <Button disabled={busy} type="submit" variant="primary">
                {busy ? t('importing') : t('import')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Closing freezes every reconciliation through a date; reopening says why. */
export function PeriodControls({
  accountId,
  workspace,
  onDone,
}: {
  accountId: string
  workspace: Workspace
  onDone: Done
}) {
  const t = useTranslations('reconciliation')
  const date = useDate()
  const [error, setError] = useState('')
  const [reopening, setReopening] = useState(false)
  const closure = workspace.closure

  const run = async (refusal: Promise<string | null>, notice: string) => {
    setError('')
    const refused = await refusal
    if (refused) setError(refused)
    else {
      setReopening(false)
      await onDone(notice)
    }
  }

  return (
    <div className="reconciliation-period">
      {closure ? (
        <>
          <span>{t('closedThrough', { date: date(`${closure.through}T12:00:00`) })}</span>
          {reopening ? (
            <form
              className="receivable-inline-form"
              onSubmit={(event) => {
                event.preventDefault()
                const reason = String(new FormData(event.currentTarget).get('reason') ?? '')
                void run(
                  post(
                    'treasury.reconciliation.reopen',
                    `/accounts/${accountId}/reconciliation/reopen`,
                    { reason },
                    t('actionFailed'),
                  ),
                  t('reopened'),
                )
              }}
            >
              <TextField label={t('reason')} maxLength={500} minLength={3} name="reason" required />
              <div className="dialog-actions">
                <Button type="submit" variant="danger">
                  {t('reopen')}
                </Button>
              </div>
            </form>
          ) : (
            <Button onClick={() => setReopening(true)} type="button" variant="ghost">
              {t('reopen')}
            </Button>
          )}
        </>
      ) : (
        <Button
          onClick={() =>
            run(
              post(
                'treasury.reconciliation.close',
                `/accounts/${accountId}/reconciliation/close`,
                { through: workspace.to < localToday() ? workspace.to : localToday() },
                t('actionFailed'),
              ),
              t('closed'),
            )
          }
          type="button"
          variant="ghost"
        >
          {t('closePeriod', { date: date(`${workspace.to}T12:00:00`) })}
        </Button>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
