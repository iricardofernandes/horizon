'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Tabs } from '@base-ui/react/tabs'
import { X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { LoadingState, Notice } from '@/components/ui/state'
import { reference } from '@/features/sales/types'
import { readJson } from '@/lib/api'
import { useStatusLabel } from '@/lib/status'
import { useDate, useMoney } from '@/lib/use-format'
import { BilledPeriodsTab, RevisionsTab, ScheduleTab } from './contract-tabs'
import { command, nameOf, type ServicesData } from './services-data'
import {
  type BilledPeriod,
  type Contract,
  futureStarts,
  periodAmount,
  revisionInForce,
  SALES_API,
  type SchedulePeriod,
  utcToday,
} from './types'

export type ContractDetail = {
  contract: Contract
  periods: SchedulePeriod[]
  billed: BilledPeriod[]
}

export type ContractRun = (
  name: string,
  path: string,
  body?: unknown,
  idempotent?: boolean,
) => Promise<boolean>

/** A year and a month past today: enough schedule to decide the next changes on. */
function scheduleEnd(): string {
  const day = new Date()
  day.setUTCDate(day.getUTCDate() + 400)
  return day.toISOString().slice(0, 10)
}

async function loadContract(contractId: string): Promise<ContractDetail> {
  const base = `${SALES_API}/contracts/${contractId}`
  const contract = await readJson<Contract>('sales.contract', base)
  const [schedule, billed] = await Promise.all([
    readJson<{ periods: SchedulePeriod[] }>(
      'sales.contract.schedule',
      `${base}/schedule?from=${contract.startsOn}&to=${scheduleEnd()}`,
    ),
    readJson<{ periods: BilledPeriod[] }>('sales.contract.billed', `${base}/billed-periods`),
  ])
  return { contract, periods: schedule.periods, billed: billed.periods }
}

/**
 * One contract: its terms and decisions, the revisions it bills from, the schedule of its
 * periods, and every billed period with what it raised in Financial and Fiscal.
 */
export function ContractDialog({
  contractId,
  data,
  canWrite,
  onClose,
  onChanged,
}: {
  contractId: string
  data: ServicesData
  canWrite: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('services')
  const common = useTranslations('common')
  const [detail, setDetail] = useState<ContractDetail | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setDetail(await loadContract(contractId))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [contractId])

  useEffect(() => {
    void load()
  }, [load])

  const run: ContractRun = async (name, path, body, idempotent = false) => {
    setBusy(true)
    setError('')
    const result = await command(name, path, { body, idempotent, fallback: t('failed') })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return false
    }
    await Promise.all([load(), onChanged()])
    return true
  }

  return (
    <Dialog.Root onOpenChange={(open) => (open ? undefined : onClose())} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup document-dialog contract-dialog">
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {failed ? <Notice copy={t('detailUnavailable')} /> : null}
          {!failed && !detail ? <LoadingState /> : null}
          {detail ? (
            <>
              <Heading detail={detail} />
              {error ? <Notice copy={error} /> : null}
              <Tabs.Root defaultValue="summary">
                <Tabs.List aria-label={t('contracts.sections')} className="ui-tabs-list">
                  <Tabs.Tab className="ui-tab" value="summary">
                    {t('contracts.tabs.summary')}
                  </Tabs.Tab>
                  <Tabs.Tab className="ui-tab" value="revisions">
                    {t('contracts.tabs.revisions')}
                  </Tabs.Tab>
                  <Tabs.Tab className="ui-tab" value="schedule">
                    {t('contracts.tabs.schedule')}
                  </Tabs.Tab>
                  <Tabs.Tab className="ui-tab" value="billed">
                    {t('contracts.tabs.billed')}
                  </Tabs.Tab>
                </Tabs.List>
                <Tabs.Panel className="contract-tab" value="summary">
                  <Summary busy={busy} canWrite={canWrite} data={data} detail={detail} run={run} />
                </Tabs.Panel>
                <Tabs.Panel className="contract-tab" value="revisions">
                  <RevisionsTab
                    busy={busy}
                    canWrite={canWrite}
                    data={data}
                    detail={detail}
                    run={run}
                  />
                </Tabs.Panel>
                <Tabs.Panel className="contract-tab" value="schedule">
                  <ScheduleTab busy={busy} canWrite={canWrite} detail={detail} run={run} />
                </Tabs.Panel>
                <Tabs.Panel className="contract-tab" value="billed">
                  <BilledPeriodsTab busy={busy} canWrite={canWrite} detail={detail} run={run} />
                </Tabs.Panel>
              </Tabs.Root>
            </>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Heading({ detail }: { detail: ContractDetail }) {
  const t = useTranslations('services')
  const label = useStatusLabel()
  return (
    <div className="dialog-heading">
      <Dialog.Title>
        {t('contracts.detailTitle', { id: reference('CTR', detail.contract.id) })}
      </Dialog.Title>
      <Badge label={label(detail.contract.status)} status={detail.contract.status} />
    </div>
  )
}

function Summary({
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
  const revision = revisionInForce(contract.revisions, utcToday()) ?? contract.revisions[0]
  return (
    <>
      <dl className="document-facts">
        <div>
          <dt>{t('customer')}</dt>
          <dd>{nameOf(data.customers, contract.customerId)}</dd>
        </div>
        <div>
          <dt>{t('contracts.recurrence')}</dt>
          <dd>{revision ? t(`recurrence.${revision.recurrence}`) : '—'}</dd>
        </div>
        <div>
          <dt>{t('contracts.perPeriod')}</dt>
          <dd>{revision ? money(periodAmount(revision), contract.currency) : '—'}</dd>
        </div>
        <div>
          <dt>{t('contracts.term')}</dt>
          <dd>
            {date(contract.startsOn)} –{' '}
            {contract.endsOn ? date(contract.endsOn) : t('contracts.openEnded')}
          </dd>
        </div>
        <div>
          <dt>{t('contracts.billingDay')}</dt>
          <dd>{contract.billingDay}</dd>
        </div>
        <div>
          <dt>{t('contracts.autoRenew')}</dt>
          <dd>{contract.autoRenew ? t('yes') : t('no')}</dd>
        </div>
      </dl>
      {contract.suspensions.length > 0 ? (
        <>
          <h3 className="document-section-title">{t('contracts.suspensions')}</h3>
          <ul className="contract-suspensions">
            {contract.suspensions.map((suspension) => (
              <li key={suspension.id}>
                {t('contracts.suspendedBetween', {
                  from: date(suspension.from),
                  until: suspension.until ? date(suspension.until) : t('contracts.openEnded'),
                  reason: suspension.reason,
                })}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {contract.cancelledFrom ? (
        <p className="document-note">
          {t('contracts.cancelledFrom', {
            from: date(contract.cancelledFrom),
            reason: contract.cancellationReason ?? '',
          })}
        </p>
      ) : null}
      {canWrite ? <Decisions busy={busy} detail={detail} run={run} /> : null}
    </>
  )
}

/**
 * The decisions a contract takes: activation, suspension, resumption and cancellation, each
 * from a future period start that has not been billed.
 */
function Decisions({
  detail,
  busy,
  run,
}: {
  detail: ContractDetail
  busy: boolean
  run: ContractRun
}) {
  const t = useTranslations('services')
  const date = useDate()
  const { contract } = detail
  const starts = futureStarts(detail.periods, utcToday())
  const [from, setFrom] = useState(starts[0] ?? '')
  const [reason, setReason] = useState('')
  const base = `${SALES_API}/contracts/${contract.id}`
  const open = contract.suspensions.find((suspension) => !suspension.until)
  const active = contract.stage === 'active' && !contract.cancelledFrom
  const reasoned = reason.trim().length >= 3

  if (contract.stage === 'draft')
    return (
      <div className="dialog-actions">
        <Button
          disabled={busy}
          onClick={() => run('sales.contract.activate', `${base}/activate`)}
          variant="primary"
        >
          {t('contracts.activate')}
        </Button>
      </div>
    )
  if (!active || starts.length === 0) return null
  return (
    <div className="contract-decisions">
      <h3 className="document-section-title">{t('contracts.decisions')}</h3>
      <div className="form-grid two-columns">
        <SelectField
          label={t('contracts.fromPeriod')}
          name="from"
          onValueChange={(value) => setFrom(value ?? '')}
          options={starts.map((start) => ({ label: date(start), value: start }))}
          value={from}
        />
        <label className="document-reason">
          <span className="ui-field-label">{t('reason')}</span>
          <input
            className="ui-input"
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
        </label>
      </div>
      <div className="dialog-actions">
        {open ? (
          <Button
            disabled={busy || !from}
            onClick={() => run('sales.contract.resume', `${base}/resume`, { at: from })}
            variant="secondary"
          >
            {t('contracts.resume')}
          </Button>
        ) : (
          <Button
            disabled={busy || !from || !reasoned}
            onClick={() =>
              run('sales.contract.suspend', `${base}/suspensions`, { from, reason: reason.trim() })
            }
            variant="secondary"
          >
            {t('contracts.suspend')}
          </Button>
        )}
        <Button
          disabled={busy || !from || !reasoned}
          onClick={() =>
            run('sales.contract.cancel', `${base}/cancel`, { from, reason: reason.trim() })
          }
          variant="secondary"
        >
          {t('contracts.cancel')}
        </Button>
      </div>
    </div>
  )
}
