'use client'

import { ArrowsLeftRight, Bank, Plus } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { localToday } from '@/features/titles/types'
import { minorUnits } from '@/lib/format'
import { FormDialog } from './form-dialog'
import { ACCOUNT_KINDS, type AccountKind, type TreasuryAccount } from './types'

const CURRENCY = 'BRL'
const AMOUNT_PATTERN = '[0-9]+([.,][0-9]{1,2})?'

const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim()

export function OpenAccountDialog({ onDone }: { onDone: (notice: string) => Promise<void> }) {
  const t = useTranslations('treasury')
  const [kind, setKind] = useState<AccountKind>('bank')
  return (
    <FormDialog
      build={(form) => {
        const amount = minorUnits(field(form, 'openingBalance') || '0')
        if (amount === null) return t('invalidAmount')
        const bank =
          kind === 'bank'
            ? {
                bank: {
                  bankCode: field(form, 'bankCode'),
                  branch: field(form, 'branch'),
                  accountNumber: field(form, 'accountNumber'),
                },
              }
            : {}
        return {
          name: 'treasury.account.open',
          path: '/accounts',
          body: {
            kind,
            name: field(form, 'name'),
            currency: CURRENCY,
            ...bank,
            openedOn: field(form, 'openedOn'),
            openingBalance: {
              amount,
              direction: field(form, 'openingDirection') === 'outflow' ? 'outflow' : 'inflow',
            },
          },
        }
      }}
      description={t('openAccountDescription')}
      onDone={onDone}
      submitLabel={t('openAccount')}
      success={t('accountOpened')}
      title={t('openAccount')}
      trigger={
        <>
          <Bank aria-hidden="true" size={17} />
          {t('openAccount')}
        </>
      }
      triggerVariant="secondary"
    >
      <div className="form-grid two-columns">
        <TextField label={t('accountName')} maxLength={120} minLength={2} name="name" required />
        <SelectField
          label={t('kind')}
          name="kind"
          onValueChange={(value) => setKind((value ?? 'bank') as AccountKind)}
          options={ACCOUNT_KINDS.map((value) => ({ value, label: t(`kinds.${value}`) }))}
          value={kind}
        />
      </div>
      {kind === 'bank' ? (
        <div className="form-grid three-columns">
          <TextField
            inputMode="numeric"
            label={t('bankCode')}
            maxLength={3}
            name="bankCode"
            pattern="[0-9]{3}"
            required
          />
          <TextField label={t('branch')} maxLength={10} name="branch" required />
          <TextField label={t('accountNumber')} maxLength={20} name="accountNumber" required />
        </div>
      ) : null}
      <div className="form-grid three-columns">
        <TextField
          defaultValue={localToday()}
          label={t('openedOn')}
          name="openedOn"
          required
          type="date"
        />
        <TextField
          inputMode="decimal"
          label={t('openingBalance')}
          name="openingBalance"
          pattern={AMOUNT_PATTERN}
          placeholder="0.00"
        />
        <SelectField
          label={t('openingSide')}
          name="openingDirection"
          options={[
            { value: 'inflow', label: t('openingInflow') },
            { value: 'outflow', label: t('openingOutflow') },
          ]}
        />
      </div>
    </FormDialog>
  )
}

export function TransferDialog({
  accounts,
  onDone,
}: {
  accounts: TreasuryAccount[]
  onDone: (notice: string) => Promise<void>
}) {
  const t = useTranslations('treasury')
  const options = accounts
    .filter((account) => account.active)
    .map((account) => ({ value: account.id, label: account.name }))
  if (options.length < 2) return null
  return (
    <FormDialog
      build={(form) => {
        const amount = minorUnits(field(form, 'amount'))
        const fee = minorUnits(field(form, 'fee') || '0')
        if (!amount || amount === '0' || fee === null) return t('invalidAmount')
        const fromAccountId = field(form, 'fromAccountId')
        const toAccountId = field(form, 'toAccountId')
        if (fromAccountId === toAccountId) return t('sameAccount')
        return {
          name: 'treasury.transfer.post',
          path: '/transfers',
          body: {
            fromAccountId,
            toAccountId,
            amount,
            ...(fee === '0' ? {} : { fee }),
            currency: CURRENCY,
            valueOn: field(form, 'valueOn'),
            memo: field(form, 'memo') || undefined,
          },
        }
      }}
      description={t('transferDescription')}
      onDone={onDone}
      submitLabel={t('transfer')}
      success={t('transferred')}
      title={t('newTransfer')}
      trigger={
        <>
          <ArrowsLeftRight aria-hidden="true" size={17} />
          {t('newTransfer')}
        </>
      }
    >
      <div className="form-grid two-columns">
        <SelectField
          defaultValue={options[0]?.value ?? null}
          label={t('fromAccount')}
          name="fromAccountId"
          options={options}
        />
        <SelectField
          defaultValue={options[1]?.value ?? null}
          label={t('toAccount')}
          name="toAccountId"
          options={options}
        />
      </div>
      <div className="form-grid three-columns">
        <TextField
          inputMode="decimal"
          label={t('amount')}
          name="amount"
          pattern={AMOUNT_PATTERN}
          placeholder="0.00"
          required
        />
        <TextField
          inputMode="decimal"
          label={t('fee')}
          name="fee"
          pattern={AMOUNT_PATTERN}
          placeholder="0.00"
        />
        <TextField
          defaultValue={localToday()}
          label={t('valueOn')}
          name="valueOn"
          required
          type="date"
        />
      </div>
      <TextField label={t('memo')} maxLength={200} name="memo" />
    </FormDialog>
  )
}

export function EntryDialog({
  account,
  onDone,
}: {
  account: TreasuryAccount
  onDone: (notice: string) => Promise<void>
}) {
  const t = useTranslations('treasury')
  return (
    <FormDialog
      build={(form) => {
        const amount = minorUnits(field(form, 'amount'))
        if (!amount || amount === '0') return t('invalidAmount')
        return {
          name: 'treasury.entry.record',
          path: `/accounts/${account.id}/entries`,
          body: {
            direction: field(form, 'direction') === 'inflow' ? 'inflow' : 'outflow',
            amount,
            currency: account.currency,
            valueOn: field(form, 'valueOn'),
            counterparty: field(form, 'counterparty') || undefined,
            memo: field(form, 'memo') || undefined,
          },
        }
      }}
      description={t('entryDescription', { account: account.name })}
      onDone={onDone}
      submitLabel={t('recordEntry')}
      success={t('entryRecorded')}
      title={t('newEntry')}
      trigger={
        <>
          <Plus aria-hidden="true" size={17} />
          {t('newEntry')}
        </>
      }
      triggerVariant="secondary"
    >
      <div className="form-grid three-columns">
        <SelectField
          label={t('direction')}
          name="direction"
          options={[
            { value: 'outflow', label: t('outflow') },
            { value: 'inflow', label: t('inflow') },
          ]}
        />
        <TextField
          inputMode="decimal"
          label={t('amount')}
          name="amount"
          pattern={AMOUNT_PATTERN}
          placeholder="0.00"
          required
        />
        <TextField
          defaultValue={localToday()}
          label={t('valueOn')}
          min={account.openedOn}
          name="valueOn"
          required
          type="date"
        />
      </div>
      <div className="form-grid two-columns">
        <TextField label={t('counterparty')} maxLength={200} name="counterparty" />
        <TextField label={t('memo')} maxLength={200} name="memo" />
      </div>
    </FormDialog>
  )
}
