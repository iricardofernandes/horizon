'use client'

import { useTranslations } from 'next-intl'
import { useRef, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PanelHeading } from '@/components/ui/headings'
import { SelectField } from '@/components/ui/select-field'
import { Empty, Notice } from '@/components/ui/state'
import { reference } from '@/features/sales/types'
import { readJson } from '@/lib/api'
import { useStatusLabel } from '@/lib/status'
import { useDate, useDateTime, useMoney } from '@/lib/use-format'
import { command, nameOf, type ServicesData } from './services-data'
import {
  type BillingOverview,
  type BillingPreview,
  type BillingRun,
  periodReference,
  recentCompetences,
  SALES_API,
  totalsOf,
  utcToday,
} from './types'

export type BillingData = ServicesData & { overview: BillingOverview }

/**
 * A month's billing: what a run would do, the run itself, and what billing still waits
 * for. A run bills each contract once; running the month again bills nothing twice.
 */
export function BillingView({
  data,
  canWrite,
  onChanged,
}: {
  data: BillingData
  canWrite: boolean
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('services')
  const setNotice = useNotice()
  const months = recentCompetences(utcToday())
  const [month, setMonth] = useState(months[0] ?? '')
  const [preview, setPreview] = useState<BillingPreview | null>(null)
  const [run, setRun] = useState<BillingRun | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // One key per month until its run answers, so a retried click resumes the same run.
  const keys = useRef(new Map<string, string>())

  async function loadPreview(competence: string) {
    setBusy(true)
    setError('')
    const result = await command<BillingPreview>(
      'sales.billing-run.preview',
      `${SALES_API}/billing-runs/preview`,
      { body: { competence }, fallback: t('failed') },
    )
    setBusy(false)
    if (!result.ok) setError(result.error)
    else setPreview(result.body)
  }

  async function commit() {
    const key = keys.current.get(month) ?? crypto.randomUUID()
    keys.current.set(month, key)
    setBusy(true)
    setError('')
    const result = await command<BillingRun>(
      'sales.billing-run.start',
      `${SALES_API}/billing-runs`,
      {
        body: { competence: month },
        key,
        fallback: t('failed'),
      },
    )
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    keys.current.delete(month)
    setRun(result.body)
    setPreview(null)
    setNotice(t('billing.ran', { month }))
    await onChanged()
  }

  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('billing.title')}</h1>
        <p className="catalog-page-copy">{t('billing.copy')}</p>
      </header>

      <section className="panel">
        <PanelHeading copy={t('billing.monthCopy')} title={t('billing.monthTitle')} />
        <div className="billing-controls">
          <SelectField
            label={t('competence')}
            name="competence"
            onValueChange={(value) => {
              setMonth(value ?? '')
              setPreview(null)
              setRun(null)
            }}
            options={months.map((value) => ({ label: value, value }))}
            value={month}
          />
          <Button disabled={busy || !month} onClick={() => loadPreview(month)} variant="secondary">
            {t('billing.preview')}
          </Button>
          {canWrite ? (
            <Button disabled={busy || !month} onClick={commit} variant="primary">
              {t('billing.run')}
            </Button>
          ) : null}
        </div>
        {error ? <Notice copy={error} /> : null}
        {preview ? (
          <Outcomes data={data} items={preview.items} title={t('billing.previewTitle')} />
        ) : null}
        {run ? <RunResult data={data} run={run} /> : null}
      </section>

      <RecentRuns data={data} />
      <Gaps data={data} />
    </section>
  )
}

type OutcomeRow = {
  contractId: string
  customerId: string
  outcome: string
  reason: string | null
  billingOn?: string
  amount?: { amount: string; currency: string }
  billedPeriodId?: string | null
}

/** What happened, or would happen, to each contract of the month, and why. */
function Outcomes({
  items,
  data,
  title,
}: {
  items: readonly OutcomeRow[]
  data: ServicesData
  title: string
}) {
  const t = useTranslations('services')
  const label = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  const totals = totalsOf(items)
  return (
    <>
      <h3 className="document-section-title">{title}</h3>
      <p className="billing-totals">
        {t('billing.totals', {
          billed: totals.billed,
          skipped: totals.skipped,
          refused: totals.refused,
          pending: totals.pending,
        })}
      </p>
      {items.length === 0 ? (
        <Empty copy={t('billing.noContracts')} />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('contracts.contract')}</th>
                <th>{t('customer')}</th>
                <th>{t('billing.outcome')}</th>
                <th>{t('billing.why')}</th>
                <th>{t('contracts.billingOn')}</th>
                <th className="numeric">{t('value')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.contractId}>
                  <td>
                    <code>{reference('CTR', item.contractId)}</code>
                  </td>
                  <td>{nameOf(data.customers, item.customerId)}</td>
                  <td>
                    <Badge label={label(item.outcome)} status={item.outcome} />
                  </td>
                  <td>
                    {item.reason
                      ? t(`reasons.${item.reason}`)
                      : item.billedPeriodId
                        ? periodReference(item.billedPeriodId)
                        : '—'}
                  </td>
                  <td>{item.billingOn ? date(item.billingOn) : '—'}</td>
                  <td className="numeric">
                    {item.amount ? money(item.amount.amount, item.amount.currency) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function RunResult({ run, data }: { run: BillingRun; data: ServicesData }) {
  const t = useTranslations('services')
  const label = useStatusLabel()
  return (
    <div className="billing-run">
      <p>
        {t('billing.runSummary', { id: reference('RUN', run.id), month: run.competence })}{' '}
        <Badge label={label(run.status)} status={run.status} />
      </p>
      <Outcomes data={data} items={run.items ?? []} title={t('billing.runTitle')} />
    </div>
  )
}

function RecentRuns({ data }: { data: BillingData }) {
  const t = useTranslations('services')
  const label = useStatusLabel()
  const dateTime = useDateTime()
  const [open, setOpen] = useState<BillingRun | null>(null)
  const runs = data.overview.runs
  return (
    <section className="panel">
      <PanelHeading copy={t('billing.recentCopy')} title={t('billing.recentTitle')} />
      {runs.length === 0 ? (
        <Empty copy={t('billing.noRuns')} />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('billing.runColumn')}</th>
                <th>{t('competence')}</th>
                <th>{t('status')}</th>
                <th>{t('billing.totalsColumn')}</th>
                <th>{t('billing.startedAt')}</th>
                <th aria-label={t('actions')} />
              </tr>
            </thead>
            <tbody>
              {runs.map((row) => (
                <tr key={row.id}>
                  <td>
                    <code>{reference('RUN', row.id)}</code>
                  </td>
                  <td>{row.competence}</td>
                  <td>
                    <Badge label={label(row.status)} status={row.status} />
                  </td>
                  <td>
                    {t('billing.totals', {
                      billed: row.totals.billed,
                      skipped: row.totals.skipped,
                      refused: row.totals.refused,
                      pending: row.totals.pending,
                    })}
                  </td>
                  <td>{dateTime(row.startedAt)}</td>
                  <td>
                    <Button
                      onClick={async () =>
                        setOpen(
                          await readJson<BillingRun>(
                            'sales.billing-run',
                            `${SALES_API}/billing-runs/${row.id}`,
                          ),
                        )
                      }
                      type="button"
                      variant="secondary"
                    >
                      {t('open')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open ? <RunResult data={data} run={open} /> : null}
    </section>
  )
}

/** Billed periods past the threshold still waiting for a receivable or an NFS-e. */
function Gaps({ data }: { data: BillingData }) {
  const t = useTranslations('services')
  const dateTime = useDateTime()
  const { awaitingReceivable, awaitingNfse, thresholdSeconds } = data.overview
  const rows = [
    ...awaitingReceivable.map((gap) => ({ ...gap, missing: t('billing.missingReceivable') })),
    ...awaitingNfse.map((gap) => ({ ...gap, missing: t('billing.missingNfse') })),
  ]
  return (
    <section className="panel">
      <PanelHeading
        copy={t('billing.gapsCopy', { days: Math.round(thresholdSeconds / 86_400) })}
        title={t('billing.gapsTitle')}
      />
      {rows.length === 0 ? (
        <Empty copy={t('billing.noGaps')} />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('billing.billedPeriod')}</th>
                <th>{t('contracts.contract')}</th>
                <th>{t('competence')}</th>
                <th>{t('billing.missing')}</th>
                <th>{t('billing.billedAt')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((gap) => (
                <tr key={`${gap.billedPeriodId}-${gap.missing}`}>
                  <td>
                    <code>{periodReference(gap.billedPeriodId)}</code>
                  </td>
                  <td>
                    <code>{reference('CTR', gap.contractId)}</code>
                  </td>
                  <td>{gap.competence}</td>
                  <td>{gap.missing}</td>
                  <td>{dateTime(gap.billedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
