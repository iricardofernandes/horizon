'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { useStatusLabel } from '@/lib/status'
import { useDate, useMoney } from '@/lib/use-format'
import { ReasonAction } from './reason-action'
import type { TransferRow, TreasuryAbilities } from './types'

export function TransfersPanel({
  transfers,
  abilities,
  onDone,
}: {
  transfers: TransferRow[]
  abilities: TreasuryAbilities
  onDone: (notice: string) => Promise<void>
}) {
  const t = useTranslations('treasury')
  const common = useTranslations('common')
  const statusLabel = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  return (
    <section className="panel table-panel treasury-transfers">
      <header className="inventory-table-heading">
        <div>
          <h2>{t('transfers')}</h2>
          <p className="inventory-table-copy">{t('transfersCopy')}</p>
        </div>
      </header>
      {transfers.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('valueOn')}</th>
                <th>{t('fromAccount')}</th>
                <th>{t('toAccount')}</th>
                <th className="numeric">{t('amount')}</th>
                <th className="numeric">{t('fee')}</th>
                <th>{t('status')}</th>
                <th aria-label={common('actions')} />
              </tr>
            </thead>
            <tbody>
              {transfers.map((transfer) => (
                <tr key={transfer.id}>
                  <td>{date(`${transfer.valueOn}T12:00:00`)}</td>
                  <td>{transfer.fromAccountName}</td>
                  <td>{transfer.toAccountName}</td>
                  <td className="numeric">{money(transfer.amount, transfer.currency)}</td>
                  <td className="numeric">
                    {transfer.fee ? money(transfer.fee, transfer.currency) : '—'}
                  </td>
                  <td>
                    <Badge label={statusLabel(transfer.status)} status={transfer.status} />
                  </td>
                  <td>
                    {abilities.canReverse && transfer.status === 'posted' ? (
                      <ReasonAction
                        label={t('cancelTransfer')}
                        name="treasury.transfer.cancel"
                        onDone={onDone}
                        path={`/transfers/${transfer.id}/cancel`}
                        success={t('transferCancelled')}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="catalog-page-copy">{t('noTransfers')}</p>
      )}
    </section>
  )
}
