'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { LoadingState, Notice } from '@/components/ui/state'
import { localToday } from '@/features/titles/types'
import { readJson } from '@/lib/api'
import { useDate, useMoney } from '@/lib/use-format'
import { ReasonAction } from './reason-action'
import { EntryDialog } from './treasury-dialogs'
import {
  isNegative,
  reversible,
  type Statement,
  type StatementLine,
  shiftDays,
  TREASURY_API,
  type TreasuryAbilities,
  type TreasuryAccount,
} from './types'

/**
 * The account journal between two value dates, each line with the balance right after it.
 * The balance before the first line is everything dated earlier, so a backdated entry moves
 * every later balance and nothing is rewritten.
 */
export function AccountStatement({
  account,
  abilities,
  onChanged,
}: {
  account: TreasuryAccount
  abilities: TreasuryAbilities
  onChanged: (notice: string) => Promise<void>
}) {
  const t = useTranslations('treasury')
  const money = useMoney()
  const [to, setTo] = useState(localToday())
  const [from, setFrom] = useState(shiftDays(localToday(), -30))
  const [statement, setStatement] = useState<Statement | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatement(
        await readJson<Statement>(
          'treasury.account.statement',
          `${TREASURY_API}/accounts/${account.id}/statement?from=${from}&to=${to}`,
        ),
      )
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [account.id, from, to])

  useEffect(() => {
    void load()
  }, [load])

  const done = async (notice: string) => {
    await Promise.all([load(), onChanged(notice)])
  }

  return (
    <section
      aria-label={t('statementOf', { account: account.name })}
      className="panel treasury-statement"
    >
      <header className="inventory-table-heading">
        <div>
          <h2>{t('statementOf', { account: account.name })}</h2>
          <p className="inventory-table-copy">{t('statementCopy')}</p>
        </div>
        {abilities.canRecord && account.active ? (
          <EntryDialog account={account} onDone={done} />
        ) : null}
      </header>
      <div className="treasury-range">
        <label className="ui-field">
          <span className="ui-field-label">{t('rangeFrom')}</span>
          <input
            className="ui-input"
            max={to}
            onChange={(event) => setFrom(event.target.value)}
            type="date"
            value={from}
          />
        </label>
        <label className="ui-field">
          <span className="ui-field-label">{t('rangeTo')}</span>
          <input
            className="ui-input"
            min={from}
            onChange={(event) => setTo(event.target.value)}
            type="date"
            value={to}
          />
        </label>
      </div>
      {failed ? <Notice copy={t('statementUnavailable')} /> : null}
      {!failed && !statement ? <LoadingState /> : null}
      {statement ? (
        <>
          <dl className="receivable-facts">
            <div>
              <dt>{t('openingOfPeriod')}</dt>
              <dd>{money(statement.openingBalance, account.currency)}</dd>
            </div>
            <div>
              <dt>{t('closingOfPeriod')}</dt>
              <dd>{money(statement.closingBalance, account.currency)}</dd>
            </div>
          </dl>
          <StatementTable
            abilities={abilities}
            account={account}
            lines={statement.lines}
            onDone={done}
          />
        </>
      ) : null}
    </section>
  )
}

function StatementTable({
  account,
  lines,
  abilities,
  onDone,
}: {
  account: TreasuryAccount
  lines: StatementLine[]
  abilities: TreasuryAbilities
  onDone: (notice: string) => Promise<void>
}) {
  const t = useTranslations('treasury')
  const common = useTranslations('common')
  const money = useMoney()
  const date = useDate()
  if (!lines.length) return <p className="catalog-page-copy">{t('noEntries')}</p>
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t('valueOn')}</th>
            <th>{t('description')}</th>
            <th className="numeric">{t('inflow')}</th>
            <th className="numeric">{t('outflow')}</th>
            <th className="numeric">{t('runningBalance')}</th>
            <th aria-label={common('actions')} />
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id}>
              <td>{date(`${line.valueOn}T12:00:00`)}</td>
              <td>
                <Badge label={t(`sources.${line.source}`)} status={`entry-${line.source}`} />
                <span className="treasury-line-text">
                  {[line.counterparty, line.memo, line.reason].filter(Boolean).join(' · ')}
                </span>
                {line.reversedBy ? (
                  <small className="receivable-origin">{t('reversedLine')}</small>
                ) : null}
              </td>
              <td className="numeric">
                {line.direction === 'inflow' ? money(line.amount, account.currency) : ''}
              </td>
              <td className="numeric">
                {line.direction === 'outflow' ? money(line.amount, account.currency) : ''}
              </td>
              <td
                className={`numeric ${isNegative(line.runningBalance) ? 'treasury-negative' : ''}`}
              >
                {money(line.runningBalance, account.currency)}
              </td>
              <td>
                {abilities.canReverse && reversible(line) ? (
                  <ReasonAction
                    label={t('reverseEntry')}
                    name="treasury.entry.reverse"
                    onDone={onDone}
                    path={`/entries/${line.id}/reverse`}
                    success={t('entryReversed')}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
