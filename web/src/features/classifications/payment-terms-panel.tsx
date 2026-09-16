'use client'

import { Minus, Plus } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { CreateDialog, EmptyRow, type MutationProps, StatusCell } from './registry-parts'
import { basisPointsOf, type Classifications, percentageOf } from './types'

type Row = { key: number; dueInDays: string; percentage: string }

export function PaymentTermsPanel({
  data,
  canManage,
  onChanged,
  setNotice,
}: { data: Classifications; canManage: boolean } & MutationProps) {
  const t = useTranslations('classifications')
  const common = useTranslations('common')
  const [rows, setRows] = useState<Row[]>([{ key: 0, dueInDays: '30', percentage: '100' }])
  const total = rows.reduce((sum, row) => sum + (basisPointsOf(row.percentage) ?? 0), 0)

  function update(key: number, change: Partial<Row>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)))
  }

  return (
    <div className="panel table-panel">
      <header className="inventory-table-heading">
        <div>
          <h2>{t('paymentTerms')}</h2>
          <p className="inventory-table-copy">{t('paymentTermsCopy')}</p>
        </div>
        <CreateDialog
          build={(form) => {
            if (total !== 10_000) return t('installmentsMustTotal')
            return {
              name: String(form.get('name') ?? ''),
              installments: rows.map((row) => ({
                dueInDays: Number(row.dueInDays),
                percentage: row.percentage.replace(',', '.'),
              })),
            }
          }}
          canManage={canManage}
          description={t('newPaymentTermCopy')}
          onChanged={onChanged}
          registry="payment-terms"
          setNotice={setNotice}
          title={t('newPaymentTerm')}
          trigger={t('newPaymentTerm')}
        >
          <TextField
            label={t('name')}
            maxLength={120}
            name="name"
            placeholder="30/60/90"
            required
          />
          <div className="order-lines-heading">
            <strong>{t('installments')}</strong>
            <Button
              disabled={rows.length >= 120}
              onClick={() =>
                setRows((current) => [
                  ...current,
                  {
                    key: (current.at(-1)?.key ?? 0) + 1,
                    dueInDays: String(Number(current.at(-1)?.dueInDays ?? 0) + 30),
                    percentage: '',
                  },
                ])
              }
              type="button"
              variant="secondary"
            >
              <Plus aria-hidden="true" size={15} /> {t('addInstallment')}
            </Button>
          </div>
          <div className="order-lines">
            {rows.map((row, index) => (
              <div className="order-line" key={row.key}>
                <TextField
                  inputMode="numeric"
                  label={t('dueInDays', { number: index + 1 })}
                  onChange={(event) => update(row.key, { dueInDays: event.currentTarget.value })}
                  pattern="[0-9]{1,4}"
                  required
                  value={row.dueInDays}
                />
                <TextField
                  inputMode="decimal"
                  label={t('percentage')}
                  onChange={(event) => update(row.key, { percentage: event.currentTarget.value })}
                  pattern="[0-9]{1,3}([.,][0-9]{1,2})?"
                  required
                  value={row.percentage}
                />
                <Button
                  aria-label={t('removeInstallment', { number: index + 1 })}
                  className="remove-order-line"
                  disabled={rows.length === 1}
                  onClick={() =>
                    setRows((current) => current.filter((candidate) => candidate.key !== row.key))
                  }
                  type="button"
                >
                  <Minus aria-hidden="true" size={16} />
                </Button>
              </div>
            ))}
          </div>
          <p className={total === 10_000 ? 'settings-card-caption' : 'form-error'}>
            {t('installmentsTotal', { total: percentageOf(total) })}
          </p>
        </CreateDialog>
      </header>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('installments')}</th>
              <th aria-label={common('actions')} />
            </tr>
          </thead>
          <tbody>
            {data.paymentTerms.map((term) => (
              <tr key={term.id}>
                <td>{term.name}</td>
                <td>
                  <div className="role-list">
                    {numbered(term.installments).map((installment) => (
                      <span className="role-chip" key={installment.number}>
                        {t('installmentChip', {
                          days: installment.dueInDays,
                          percentage: percentageOf(installment.basisPoints),
                        })}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <StatusCell
                    active={term.active}
                    canManage={canManage}
                    id={term.id}
                    label={term.name}
                    onChanged={onChanged}
                    registry="payment-terms"
                    setNotice={setNotice}
                  />
                </td>
              </tr>
            ))}
            {!data.paymentTerms.length ? (
              <EmptyRow columns={3} copy={t('emptyPaymentTerms')} />
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** A term's installments never reorder, so their position is their identity. */
function numbered<T>(installments: readonly T[]): (T & { number: number })[] {
  return installments.map((installment, position) => ({ ...installment, number: position + 1 }))
}
