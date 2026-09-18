'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useDate, useMoney } from '@/lib/use-format'
import {
  type CashFlow,
  type CashFlowOutlook,
  type ChartAccount,
  type IncomeStatement,
  isNegative,
  type StatementRow,
  type TrialBalance,
} from './types'

const BRL = 'BRL'

/**
 * What the period earned and spent.
 *
 * A parent shows what everything under it adds up to; a leaf shows what it alone moved.
 * Only the leaves are totalled, so a group and its children are never counted twice.
 */
export function IncomeStatementPanel({ statement }: { statement: IncomeStatement }) {
  const t = useTranslations('ledger')
  const money = useMoney()
  const negative = isNegative(statement.result)
  return (
    <div className="panel ledger-report">
      <Section rows={statement.revenue} title={t('revenue')} total={statement.totalRevenue} />
      <Section rows={statement.expense} title={t('expense')} total={statement.totalExpense} />
      <p className={`ledger-result${negative ? ' ledger-result-negative' : ''}`}>
        <span>{negative ? t('loss') : t('profit')}</span>
        <strong>{money(statement.result, BRL)}</strong>
      </p>
    </div>
  )
}

function Section({ title, rows, total }: { title: string; rows: StatementRow[]; total: string }) {
  const t = useTranslations('ledger')
  const money = useMoney()
  if (!rows.length) return null
  return (
    <section className="ledger-section">
      <h2 className="ledger-section-title">{title}</h2>
      <table>
        <thead>
          <tr>
            <th>{t('account')}</th>
            <th className="numeric">{t('amount')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className={row.postable ? undefined : 'ledger-group'} key={row.accountId}>
              <td style={{ paddingLeft: `${(row.depth - 1) * 1.25}rem` }}>
                <code>{row.code}</code> {row.name}
              </td>
              <td className="numeric">{money(row.postable ? row.amount : row.rollUp, BRL)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>{t('total')}</th>
            <td className="numeric">{money(total, BRL)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  )
}

/**
 * Cash that moved, beside cash that is still expected.
 *
 * The two come from different modules and mean different things — one is history, the
 * other a claim or a guess — so they are shown side by side and never added together.
 */
export function CashFlowPanel({
  cashFlow,
  outlook,
}: {
  cashFlow: CashFlow
  outlook: CashFlowOutlook
}) {
  const t = useTranslations('ledger')
  const money = useMoney()
  const date = useDate()
  const expected = new Map(outlook.buckets.map((bucket) => [bucket.startsOn, bucket]))
  if (!cashFlow.accounts.length)
    return (
      <div className="panel catalog-empty">
        <strong>{t('noCashAccounts')}</strong>
        <p>{t('noCashAccountsCopy')}</p>
      </div>
    )
  return (
    <div className="panel table-panel">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('period')}</th>
              <th className="numeric">{t('inflow')}</th>
              <th className="numeric">{t('outflow')}</th>
              <th className="numeric">{t('closing')}</th>
              <th className="numeric">{t('committed')}</th>
              <th className="numeric">{t('forecast')}</th>
            </tr>
          </thead>
          <tbody>
            {cashFlow.buckets.map((bucket) => {
              const ahead = expected.get(bucket.startsOn)
              return (
                <tr key={bucket.startsOn}>
                  <td>{date(bucket.startsOn)}</td>
                  <td className="numeric">{money(bucket.inflow, BRL)}</td>
                  <td className="numeric">{money(bucket.outflow, BRL)}</td>
                  <td className="numeric">{money(bucket.closing, BRL)}</td>
                  <td className="numeric">
                    {ahead ? money(ahead.committedIn, BRL) : money('0', BRL)}
                  </td>
                  <td className="numeric">
                    {ahead ? money(ahead.forecastIn, BRL) : money('0', BRL)}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <th>{t('total')}</th>
              <td className="numeric">{money(cashFlow.inflow, BRL)}</td>
              <td className="numeric">{money(cashFlow.outflow, BRL)}</td>
              <td className="numeric">{money(cashFlow.closing, BRL)}</td>
              <td className="numeric">{money(outlook.committedIn, BRL)}</td>
              <td className="numeric">{money(outlook.forecastIn, BRL)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="ledger-note">
        {t('cashAccounts', { accounts: cashFlow.accounts.map((one) => one.name).join(', ') })}
      </p>
      {outlook.overdueIn !== '0' ? (
        <p className="ledger-note">{t('overdueNote', { amount: money(outlook.overdueIn, BRL) })}</p>
      ) : null}
    </div>
  )
}

/** The two totals a trial balance exists to compare; they are equal or the books are wrong. */
export function TrialBalancePanel({
  trial,
  onOpen,
}: {
  trial: TrialBalance
  onOpen: (accountId: string) => void
}) {
  const t = useTranslations('ledger')
  const money = useMoney()
  const balanced = trial.totalDebits === trial.totalCredits
  return (
    <div className="panel table-panel">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('account')}</th>
              <th className="numeric">{t('opening')}</th>
              <th className="numeric">{t('debits')}</th>
              <th className="numeric">{t('credits')}</th>
              <th className="numeric">{t('closing')}</th>
              <th aria-label={t('lines')} />
            </tr>
          </thead>
          <tbody>
            {trial.rows.map((row) => (
              <tr key={row.accountId}>
                <td>
                  <code>{row.code}</code> {row.name}
                </td>
                <td className="numeric">{money(row.opening, row.currency)}</td>
                <td className="numeric">{money(row.debits, row.currency)}</td>
                <td className="numeric">{money(row.credits, row.currency)}</td>
                <td className="numeric">{money(row.closing, row.currency)}</td>
                <td>
                  <Button
                    aria-label={t('openLines', { account: row.code })}
                    onClick={() => onOpen(row.accountId)}
                    type="button"
                    variant="secondary"
                  >
                    {t('lines')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>{balanced ? t('balanced') : t('unbalanced')}</th>
              <td className="numeric">—</td>
              <td className="numeric">{money(trial.totalDebits, BRL)}</td>
              <td className="numeric">{money(trial.totalCredits, BRL)}</td>
              <td className="numeric">—</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {trial.rows.length ? null : (
        <div className="catalog-empty">
          <strong>{t('emptyTitle')}</strong>
          <p>{t('emptyCopy')}</p>
        </div>
      )}
    </div>
  )
}

/** The chart itself: what the workspace decided its books are made of. */
export function ChartPanel({
  chart,
  onOpen,
}: {
  chart: ChartAccount[]
  onOpen: (accountId: string) => void
}) {
  const t = useTranslations('ledger')
  const money = useMoney()
  const types = useTranslations('ledger.accountType')
  return (
    <div className="panel table-panel">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('account')}</th>
              <th>{t('type')}</th>
              <th className="numeric">{t('balance')}</th>
              <th aria-label={t('lines')} />
            </tr>
          </thead>
          <tbody>
            {chart.map((account) => (
              <tr className={account.postable ? undefined : 'ledger-group'} key={account.id}>
                <td style={{ paddingLeft: `${(account.depth - 1) * 1.25}rem` }}>
                  <code>{account.code}</code> {account.name}
                </td>
                <td>{types(account.type)}</td>
                <td className="numeric">
                  {money(account.postable ? account.balance : account.rollUp, account.currency)}
                </td>
                <td>
                  {account.postable ? (
                    <Button
                      aria-label={t('openLines', { account: account.code })}
                      onClick={() => onOpen(account.id)}
                      type="button"
                      variant="secondary"
                    >
                      {t('lines')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
