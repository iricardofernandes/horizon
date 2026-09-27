'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { minorUnits } from '@/lib/format'
import { useStatusLabel } from '@/lib/status'
import { useDate, useMoney } from '@/lib/use-format'
import type { ContractDetail, ContractRun } from './contract-dialog'
import { NfseEffectCell, ReceivableEffectCell } from './effects'
import { ServiceLines } from './service-orders-view'
import type { ServicesData } from './services-data'
import {
  type BilledPeriod,
  billableNow,
  CREDIT_REASONS,
  futureStarts,
  periodAmount,
  periodReference,
  RECURRENCES,
  SALES_API,
  type SchedulePeriod,
  utcToday,
} from './types'

/** Every revision the contract bills from, and the forms that add one. */
export function RevisionsTab({
  detail,
  data,
  canWrite,
  busy,
  run,
}: {
  detail: ContractDetail
  data: ServicesData
  canWrite: boolean
  busy: boolean
  run: ContractRun
}) {
  const t = useTranslations('services')
  const money = useMoney()
  const date = useDate()
  const { contract } = detail
  const changeable = contract.stage === 'active' && !contract.cancelledFrom
  return (
    <>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('contracts.revision')}</th>
              <th>{t('contracts.effectiveFrom')}</th>
              <th>{t('contracts.recurrence')}</th>
              <th className="numeric">{t('contracts.perPeriod')}</th>
              <th>{t('reason')}</th>
            </tr>
          </thead>
          <tbody>
            {[...contract.revisions].reverse().map((revision) => (
              <tr key={revision.number}>
                <td>
                  {revision.number} · {t(`contracts.kinds.${revision.kind}`)}
                  {revision.readjustmentBasisPoints !== null
                    ? ` · ${t('contracts.readjusted', { percent: revision.readjustmentBasisPoints / 100 })}`
                    : ''}
                </td>
                <td>{date(revision.effectiveFrom)}</td>
                <td>{t(`recurrence.${revision.recurrence}`)}</td>
                <td className="numeric">{money(periodAmount(revision), contract.currency)}</td>
                <td>{revision.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canWrite && changeable ? (
        <>
          <AmendForm busy={busy} data={data} detail={detail} run={run} />
          {contract.endsOn ? <RenewForm busy={busy} detail={detail} run={run} /> : null}
        </>
      ) : null}
    </>
  )
}

/** New lines, quantities, prices or recurrence from a period that has not begun. */
function AmendForm({
  detail,
  data,
  busy,
  run,
}: {
  detail: ContractDetail
  data: ServicesData
  busy: boolean
  run: ContractRun
}) {
  const t = useTranslations('services')
  const date = useDate()
  const starts = futureStarts(detail.periods, utcToday())
  const [version, setVersion] = useState(0)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const quantities = form.getAll('quantity').map(String)
    const prices = form.getAll('unitPrice').map(String)
    const done = await run(
      'sales.contract.amend',
      `${SALES_API}/contracts/${detail.contract.id}/amendments`,
      {
        effectiveFrom: String(form.get('effectiveFrom')),
        recurrence: String(form.get('recurrence')),
        reason: String(form.get('reason') ?? '').trim(),
        lines: form.getAll('itemId').map((itemId, index) => {
          const price = minorUnits(prices[index] ?? '')
          return {
            lineId: crypto.randomUUID(),
            itemId: String(itemId),
            quantity: quantities[index] ?? '1',
            ...(price ? { unitPrice: price } : {}),
          }
        }),
      },
      true,
    )
    if (done) setVersion((current) => current + 1)
  }

  if (starts.length === 0) return null
  return (
    <form className="contract-form" key={version} onSubmit={submit}>
      <h3 className="document-section-title">{t('contracts.amendTitle')}</h3>
      <div className="form-grid two-columns">
        <SelectField
          label={t('contracts.effectiveFrom')}
          name="effectiveFrom"
          options={starts.map((start) => ({ label: date(start), value: start }))}
        />
        <SelectField
          label={t('contracts.recurrence')}
          name="recurrence"
          options={RECURRENCES.map((value) => ({ label: t(`recurrence.${value}`), value }))}
        />
      </div>
      <ServiceLines data={data} prices />
      <TextField label={t('contracts.amendReason')} minLength={10} name="reason" required />
      <div className="dialog-actions">
        <Button disabled={busy} type="submit" variant="primary">
          {t('contracts.amend')}
        </Button>
      </div>
    </form>
  )
}

/** Renew for the original term, readjusted by a reviewer's percentage when there is one. */
function RenewForm({
  detail,
  busy,
  run,
}: {
  detail: ContractDetail
  busy: boolean
  run: ContractRun
}) {
  const t = useTranslations('services')
  const [version, setVersion] = useState(0)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const percent = String(form.get('readjustment') ?? '')
      .replace(',', '.')
      .trim()
    const done = await run(
      'sales.contract.renew',
      `${SALES_API}/contracts/${detail.contract.id}/renewals`,
      {
        reason: String(form.get('reason') ?? '').trim(),
        ...(percent ? { readjustmentBasisPoints: Math.round(Number(percent) * 100) } : {}),
      },
      true,
    )
    if (done) setVersion((current) => current + 1)
  }

  return (
    <form className="contract-form" key={version} onSubmit={submit}>
      <h3 className="document-section-title">{t('contracts.renewTitle')}</h3>
      <div className="form-grid two-columns">
        <TextField
          inputMode="decimal"
          label={t('contracts.readjustment')}
          name="readjustment"
          pattern="-?[0-9]+([.,][0-9]{1,2})?"
        />
        <TextField label={t('contracts.renewReason')} minLength={10} name="reason" required />
      </div>
      <div className="dialog-actions">
        <Button disabled={busy} type="submit" variant="secondary">
          {t('contracts.renew')}
        </Button>
      </div>
    </form>
  )
}

/** The state of one period, as a status label key. */
function periodState(period: SchedulePeriod, today: string): string {
  if (period.credited) return 'credited'
  if (period.billedPeriodId) return 'billed'
  if (period.excluded) return period.excluded
  return period.billingOn <= today ? 'due' : 'upcoming'
}

/** Every period in the next year: billed or not, and why. Due periods can be billed here. */
export function ScheduleTab({
  detail,
  canWrite,
  busy,
  run,
}: {
  detail: ContractDetail
  canWrite: boolean
  busy: boolean
  run: ContractRun
}) {
  const t = useTranslations('services')
  const label = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  const today = utcToday()
  const due = new Set(billableNow(detail.periods, today).map((period) => period.competence))
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t('competence')}</th>
            <th>{t('contracts.period')}</th>
            <th>{t('contracts.billingOn')}</th>
            <th>{t('contracts.revision')}</th>
            <th className="numeric">{t('value')}</th>
            <th>{t('status')}</th>
            <th aria-label={t('actions')} />
          </tr>
        </thead>
        <tbody>
          {detail.periods.map((period) => {
            const state = periodState(period, today)
            return (
              <tr key={period.competence}>
                <td>{period.competence}</td>
                <td>
                  {date(period.startsOn)} – {date(period.endsOn)}
                </td>
                <td>{date(period.billingOn)}</td>
                <td>{period.revision}</td>
                <td className="numeric">{money(period.amount, detail.contract.currency)}</td>
                <td>
                  <Badge label={label(state)} status={state} />
                </td>
                <td>
                  {canWrite && due.has(period.competence) ? (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        run(
                          'sales.contract.bill-period',
                          `${SALES_API}/contracts/${detail.contract.id}/periods/${period.competence}/bill`,
                          {},
                          true,
                        )
                      }
                      type="button"
                      variant="secondary"
                    >
                      {t('contracts.billPeriod')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Every billed period, frozen, with its receivable and NFS-e, and its credit. */
export function BilledPeriodsTab({
  detail,
  canWrite,
  busy,
  run,
}: {
  detail: ContractDetail
  canWrite: boolean
  busy: boolean
  run: ContractRun
}) {
  const t = useTranslations('services')
  const money = useMoney()
  if (detail.billed.length === 0)
    return <p className="document-note">{t('contracts.nothingBilled')}</p>
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t('competence')}</th>
            <th className="numeric">{t('value')}</th>
            <th>{t('effects.receivable')}</th>
            <th>{t('effects.nfse')}</th>
            <th>{t('contracts.credit')}</th>
          </tr>
        </thead>
        <tbody>
          {[...detail.billed].reverse().map((period) => (
            <tr key={period.id}>
              <td>
                {period.competence} · <code>{periodReference(period.id)}</code>
              </td>
              <td className="numeric">{money(period.value, detail.contract.currency)}</td>
              <td>
                <ReceivableEffectCell
                  effect={period.receivable}
                  reference={periodReference(period.id)}
                  withdrawn={Boolean(period.credit)}
                />
              </td>
              <td>
                {period.lines.map((line) => (
                  <div key={line.entryId}>
                    <NfseEffectCell effect={line.nfse} />
                  </div>
                ))}
              </td>
              <td>
                <CreditCell
                  busy={busy}
                  canWrite={canWrite}
                  contractId={detail.contract.id}
                  period={period}
                  run={run}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CreditCell({
  period,
  contractId,
  canWrite,
  busy,
  run,
}: {
  period: BilledPeriod
  contractId: string
  canWrite: boolean
  busy: boolean
  run: ContractRun
}) {
  const t = useTranslations('services')
  const [asking, setAsking] = useState(false)
  const [code, setCode] = useState<string>(CREDIT_REASONS[0])
  const [reason, setReason] = useState('')
  if (period.credit)
    return (
      <span>
        {t(`contracts.creditReasons.${period.credit.reasonCode}`)} · {period.credit.reason}
      </span>
    )
  if (!canWrite) return <span>—</span>
  if (!asking)
    return (
      <Button onClick={() => setAsking(true)} type="button" variant="secondary">
        {t('contracts.creditPeriod')}
      </Button>
    )
  return (
    <div className="inline-reason">
      <SelectField
        label={t('contracts.creditReason')}
        name="reasonCode"
        onValueChange={(value) => setCode(value ?? CREDIT_REASONS[0])}
        options={CREDIT_REASONS.map((value) => ({
          label: t(`contracts.creditReasons.${value}`),
          value,
        }))}
        value={code}
      />
      <input
        aria-label={t('reason')}
        className="ui-input"
        onChange={(event) => setReason(event.target.value)}
        value={reason}
      />
      <Button
        disabled={busy || reason.trim().length < 3}
        onClick={() =>
          run(
            'sales.contract.credit-period',
            `${SALES_API}/contracts/${contractId}/periods/${period.competence}/credit`,
            { reasonCode: code, reason: reason.trim() },
            true,
          )
        }
        type="button"
        variant="primary"
      >
        {t('confirm')}
      </Button>
    </div>
  )
}
