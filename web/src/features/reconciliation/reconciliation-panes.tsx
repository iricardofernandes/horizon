'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { useDate, useMoney } from '@/lib/use-format'
import { post } from './commands'
import {
  isOpen,
  type ReconciliationAbilities,
  selectedTotal,
  type Workspace,
  type WorkspaceEntry,
  type WorkspaceLine,
} from './types'

const CURRENCY = 'BRL'

/**
 * The bank's lines beside the books' entries. Selecting rows on both sides shows the
 * difference at all times; a match is offered only when it is zero, or explicitly with an
 * adjustment entry for the difference.
 */
export function ReconciliationPanes({
  accountId,
  workspace,
  abilities,
  onDone,
}: {
  accountId: string
  workspace: Workspace
  abilities: ReconciliationAbilities
  onDone: (notice: string) => Promise<void>
}) {
  const t = useTranslations('reconciliation')
  const common = useTranslations('common')
  const money = useMoney()
  const [lines, setLines] = useState<Set<string>>(new Set())
  const [entries, setEntries] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [ignoring, setIgnoring] = useState(false)
  const bank = selectedTotal(workspace.lines, lines)
  const books = selectedTotal(workspace.entries, entries)
  const difference = bank - books
  const latest = workspace.lines
    .filter((line) => lines.has(line.id))
    .map((line) => line.postedOn)
    .sort()
    .at(-1)

  const toggle = (set: Set<string>, update: (next: Set<string>) => void, id: string) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    update(next)
  }

  async function run(command: () => Promise<string | null>, notice: string) {
    setBusy(true)
    setError('')
    const refused = await command()
    setBusy(false)
    if (refused) {
      setError(refused)
      return
    }
    setLines(new Set())
    setEntries(new Set())
    setIgnoring(false)
    await onDone(notice)
  }

  const match = (adjust: boolean) =>
    run(
      () =>
        post(
          'treasury.reconciliation.match',
          `/accounts/${accountId}/reconciliations`,
          {
            statementLines: [...lines].map((id) => ({ id })),
            entries: [...entries].map((id) => ({ id })),
            ...(adjust && latest
              ? { adjustment: { valueOn: latest, memo: t('adjustmentMemo') } }
              : {}),
          },
          t('actionFailed'),
        ),
      t('matched'),
    )

  async function ignore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '')
    await run(
      () =>
        post(
          'treasury.reconciliation.ignore',
          `/accounts/${accountId}/reconciliations/ignore`,
          { statementLines: [...lines].map((id) => ({ id })), reason },
          t('actionFailed'),
        ),
      t('ignoredNotice'),
    )
  }

  return (
    <section className="reconciliation-panes">
      {abilities.canRecord ? (
        <div aria-live="polite" className="panel reconciliation-bar">
          <dl>
            <div>
              <dt>{t('selectedBank')}</dt>
              <dd>{money(bank.toString(), CURRENCY)}</dd>
            </div>
            <div>
              <dt>{t('selectedBooks')}</dt>
              <dd>{money(books.toString(), CURRENCY)}</dd>
            </div>
            <div>
              <dt>{t('difference')}</dt>
              <dd className={difference === 0n ? 'reconciliation-balanced' : 'treasury-negative'}>
                {money(difference.toString(), CURRENCY)}
              </dd>
            </div>
          </dl>
          <div className="receivable-actions">
            <Button
              disabled={busy || !lines.size || !entries.size || difference !== 0n}
              onClick={() => match(false)}
              type="button"
              variant="primary"
            >
              {t('match')}
            </Button>
            <Button
              disabled={busy || !lines.size || difference === 0n}
              onClick={() => match(true)}
              type="button"
              variant="secondary"
            >
              {t('matchWithAdjustment')}
            </Button>
            <Button
              disabled={busy || !lines.size || entries.size > 0}
              onClick={() => setIgnoring(true)}
              type="button"
              variant="ghost"
            >
              {t('ignore')}
            </Button>
          </div>
          {ignoring ? (
            <form className="receivable-inline-form" onSubmit={ignore}>
              <TextField label={t('reason')} maxLength={500} minLength={3} name="reason" required />
              <div className="dialog-actions">
                <Button onClick={() => setIgnoring(false)} type="button" variant="secondary">
                  {common('cancel')}
                </Button>
                <Button disabled={busy} type="submit" variant="danger">
                  {t('ignore')}
                </Button>
              </div>
            </form>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="reconciliation-columns">
        <LinesPane
          lines={workspace.lines}
          onToggle={(id) => toggle(lines, setLines, id)}
          selectable={abilities.canRecord}
          selected={lines}
        />
        <EntriesPane
          entries={workspace.entries}
          onToggle={(id) => toggle(entries, setEntries, id)}
          selectable={abilities.canRecord}
          selected={entries}
        />
      </div>
    </section>
  )
}

function LinesPane({
  lines,
  selected,
  selectable,
  onToggle,
}: {
  lines: WorkspaceLine[]
  selected: ReadonlySet<string>
  selectable: boolean
  onToggle: (id: string) => void
}) {
  const t = useTranslations('reconciliation')
  const money = useMoney()
  const date = useDate()
  return (
    <div className="panel table-panel">
      <h2 className="reconciliation-pane-title">{t('bankLines')}</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th aria-label={t('select')} />
              <th>{t('date')}</th>
              <th>{t('description')}</th>
              <th className="numeric">{t('amount')}</th>
              <th>{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr className={selected.has(line.id) ? 'reconciliation-selected' : ''} key={line.id}>
                <td>
                  {selectable && isOpen(line) ? (
                    <input
                      aria-label={t('selectLine', { description: line.description })}
                      checked={selected.has(line.id)}
                      onChange={() => onToggle(line.id)}
                      type="checkbox"
                    />
                  ) : null}
                </td>
                <td>{date(`${line.postedOn}T12:00:00`)}</td>
                <td>
                  {line.description}
                  {line.documentId ? (
                    <small className="receivable-origin">
                      {t('document', { document: line.documentId })}
                    </small>
                  ) : null}
                </td>
                <td className="numeric">
                  {money(line.status === 'partial' ? line.open : line.amount, CURRENCY)}
                </td>
                <td>
                  <Badge
                    label={t(`lineStatus.${line.status}`)}
                    status={`reconciliation-${line.status}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!lines.length ? <p className="catalog-page-copy">{t('noLines')}</p> : null}
    </div>
  )
}

function EntriesPane({
  entries,
  selected,
  selectable,
  onToggle,
}: {
  entries: WorkspaceEntry[]
  selected: ReadonlySet<string>
  selectable: boolean
  onToggle: (id: string) => void
}) {
  const t = useTranslations('reconciliation')
  const money = useMoney()
  const date = useDate()
  return (
    <div className="panel table-panel">
      <h2 className="reconciliation-pane-title">{t('bookEntries')}</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th aria-label={t('select')} />
              <th>{t('date')}</th>
              <th>{t('description')}</th>
              <th className="numeric">{t('amount')}</th>
              <th>{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const label =
                [entry.counterparty, entry.memo].filter(Boolean).join(' · ') ||
                t(`sources.${entry.source}`)
              return (
                <tr
                  className={selected.has(entry.id) ? 'reconciliation-selected' : ''}
                  key={entry.id}
                >
                  <td>
                    {selectable && isOpen(entry) ? (
                      <input
                        aria-label={t('selectEntry', { description: label })}
                        checked={selected.has(entry.id)}
                        onChange={() => onToggle(entry.id)}
                        type="checkbox"
                      />
                    ) : null}
                  </td>
                  <td>{date(`${entry.valueOn}T12:00:00`)}</td>
                  <td>{label}</td>
                  <td className="numeric">
                    {money(entry.status === 'partial' ? entry.open : entry.amount, CURRENCY)}
                  </td>
                  <td>
                    <Badge
                      label={t(`lineStatus.${entry.status}`)}
                      status={`reconciliation-${entry.status}`}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!entries.length ? <p className="catalog-page-copy">{t('noEntries')}</p> : null}
    </div>
  )
}
