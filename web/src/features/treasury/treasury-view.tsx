'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useStatusLabel } from '@/lib/status'
import { useDate, useMoney } from '@/lib/use-format'
import { AccountStatement } from './account-statement'
import { TransfersPanel } from './transfers-panel'
import { OpenAccountDialog, TransferDialog } from './treasury-dialogs'
import {
  isNegative,
  type MutationProps,
  type TreasuryAbilities,
  type TreasuryAccount,
  type TreasuryData,
} from './types'

/**
 * Where the company's money is, according to its own books. Every balance here is the sum
 * of the ERP journal and is labelled as such: it is never the bank's live balance.
 */
export function TreasuryView({
  data,
  abilities,
  onChanged,
  setNotice,
}: { data: TreasuryData; abilities: TreasuryAbilities } & MutationProps) {
  const t = useTranslations('treasury')
  const [selected, setSelected] = useState<string | null>(data.accounts[0]?.id ?? null)
  const account = data.accounts.find((candidate) => candidate.id === selected) ?? null
  const done = async (notice: string) => {
    setNotice(notice)
    await onChanged()
  }

  return (
    <section>
      <header className="page-heading page-heading-with-actions">
        <div>
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{t('title')}</h1>
          <p className="catalog-page-copy">{t('copy')}</p>
        </div>
        <div className="page-actions">
          {abilities.canConfigure ? <OpenAccountDialog onDone={done} /> : null}
          {abilities.canRecord ? <TransferDialog accounts={data.accounts} onDone={done} /> : null}
        </div>
      </header>

      {data.accounts.length ? (
        <div className="treasury-accounts">
          {data.accounts.map((candidate) => (
            <AccountCard
              account={candidate}
              key={candidate.id}
              onSelect={() => setSelected(candidate.id)}
              selected={candidate.id === selected}
            />
          ))}
        </div>
      ) : (
        <div className="panel catalog-empty">
          <strong>{t('emptyTitle')}</strong>
          <p>{t('emptyCopy')}</p>
        </div>
      )}

      {account ? (
        <AccountStatement
          abilities={abilities}
          account={account}
          key={account.id}
          onChanged={done}
        />
      ) : null}
      <TransfersPanel abilities={abilities} onDone={done} transfers={data.transfers} />
    </section>
  )
}

function AccountCard({
  account,
  selected,
  onSelect,
}: {
  account: TreasuryAccount
  selected: boolean
  onSelect: () => void
}) {
  const t = useTranslations('treasury')
  const statusLabel = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  const scheduled = account.projectedBalance !== account.bookBalance
  return (
    <article className={`panel treasury-account${selected ? ' treasury-account-selected' : ''}`}>
      <div className="treasury-account-heading">
        <div>
          <h2>{account.name}</h2>
          <small>
            {t(`kinds.${account.kind}`)}
            {account.bankCode
              ? ` · ${account.bankCode} · ${account.branch} · ${account.accountNumber}`
              : ''}
          </small>
        </div>
        {account.active ? null : <Badge label={statusLabel('inactive')} status="inactive" />}
      </div>
      <dl>
        <div>
          <dt>{t('bookBalance')}</dt>
          <dd className={isNegative(account.bookBalance) ? 'treasury-negative' : ''}>
            {money(account.bookBalance, account.currency)}
          </dd>
        </div>
        {scheduled ? (
          <div>
            <dt>{t('projectedBalance')}</dt>
            <dd>{money(account.projectedBalance, account.currency)}</dd>
          </div>
        ) : null}
      </dl>
      <p className="treasury-account-note">
        {t('bookBalanceNote', { date: date(`${account.asOf}T12:00:00`) })}
      </p>
      <Button
        aria-label={t('showStatementOf', { account: account.name })}
        aria-pressed={selected}
        onClick={onSelect}
        type="button"
        variant="secondary"
      >
        {t('showStatement')}
      </Button>
    </article>
  )
}
