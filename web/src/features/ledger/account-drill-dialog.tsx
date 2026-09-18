'use client'

import { Dialog } from '@base-ui/react/dialog'
import { X } from '@phosphor-icons/react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { LoadingState, Notice } from '@/components/ui/state'
import { readJson } from '@/lib/api'
import { useDate, useMoney } from '@/lib/use-format'
import { type AccountLedger, LEDGER_API, sourceHref } from './types'

/**
 * One account's lines, each naming the fact that caused it.
 *
 * This is where a report stops being a number: a figure in the result leads to the account,
 * the account to its lines, and each line back out to the receivable, the settlement or the
 * transfer it accounts for.
 */
export function AccountDrillDialog({
  accountId,
  range,
  onClose,
}: {
  accountId: string
  range: { from: string; to: string }
  onClose: () => void
}) {
  const t = useTranslations('ledger')
  const common = useTranslations('common')
  const [ledger, setLedger] = useState<AccountLedger | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let current = true
    readJson<AccountLedger>(
      'ledger.account',
      `${LEDGER_API}/accounts/${accountId}/ledger?from=${range.from}&to=${range.to}&limit=200`,
    )
      .then((value) => current && setLedger(value))
      .catch(() => current && setFailed(true))
    return () => {
      current = false
    }
  }, [accountId, range.from, range.to])

  return (
    <Dialog.Root onOpenChange={(open) => (open ? undefined : onClose())} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup ledger-dialog">
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {failed ? <Notice copy={t('drillFailed')} /> : null}
          {!failed && !ledger ? <LoadingState /> : null}
          {ledger ? <DrillBody ledger={ledger} /> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function DrillBody({ ledger }: { ledger: AccountLedger }) {
  const t = useTranslations('ledger')
  const kinds = useTranslations('ledger.sourceType')
  const money = useMoney()
  const date = useDate()
  return (
    <>
      <div className="dialog-heading">
        <Dialog.Title>{`${ledger.code} ${ledger.name}`}</Dialog.Title>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('postedOn')}</th>
              <th>{t('reference')}</th>
              <th>{t('origin')}</th>
              <th className="numeric">{t('debits')}</th>
              <th className="numeric">{t('credits')}</th>
              <th className="numeric">{t('balance')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={5}>{t('opening')}</td>
              <td className="numeric">{money(ledger.opening, ledger.currency)}</td>
            </tr>
            {ledger.data.map((line) => {
              const href = sourceHref(line)
              return (
                <tr key={`${line.transactionId}-${line.lineNumber}`}>
                  <td>{date(line.postedOn)}</td>
                  <td>{line.reference}</td>
                  <td>
                    {href ? (
                      <Link href={href}>{kinds(line.sourceType)}</Link>
                    ) : (
                      kinds(line.sourceType)
                    )}
                  </td>
                  <td className="numeric">
                    {line.side === 'debit' ? money(line.amount, ledger.currency) : '—'}
                  </td>
                  <td className="numeric">
                    {line.side === 'credit' ? money(line.amount, ledger.currency) : '—'}
                  </td>
                  <td className="numeric">{money(line.runningBalance, ledger.currency)}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={5}>{t('closing')}</th>
              <td className="numeric">{money(ledger.closing, ledger.currency)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {ledger.data.length ? null : <p className="ledger-note">{t('noLines')}</p>}
    </>
  )
}
