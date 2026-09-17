'use client'

import { Dialog } from '@base-ui/react/dialog'
import { X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingState, Notice } from '@/components/ui/state'
import { apiError, readJson } from '@/lib/api'
import { idempotentJsonHeaders, jsonHeaders } from '@/lib/http'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import { useDate, useDateTime, useMoney } from '@/lib/use-format'
import { ApprovalSection } from './approval-section'
import { ClassifyForm, ReasonForm, SettleForm } from './title-forms'
import type { MutationProps, TitleAbilities } from './titles-view'
import {
  apiBaseOf,
  approvalRequired,
  type Direction,
  displayStatus,
  type Installment,
  localToday,
  namespaceOf,
  type TitleDetail,
  type TitlesData,
} from './types'

type Props = {
  id: string
  data: TitlesData
  abilities: TitleAbilities
  onClose: () => void
} & MutationProps

type Command = (
  name: string,
  path: string,
  body: unknown,
  options?: { idempotent?: boolean; method?: 'POST' | 'PUT' },
) => Promise<boolean>

export function TitleDetailDialog({ id, data, abilities, onClose, onChanged, setNotice }: Props) {
  const { direction } = data
  const t = useTranslations(namespaceOf(direction))
  const common = useTranslations('common')
  const [detail, setDetail] = useState<TitleDetail | null>(null)
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setDetail(
        await readJson<TitleDetail>(
          `financial.${direction}.detail`,
          `${apiBaseOf(direction)}/${id}?today=${localToday()}`,
        ),
      )
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [id, direction])

  useEffect(() => {
    void load()
  }, [load])

  const command: Command = async (name, path, body, options = { idempotent: true }) => {
    setBusy(true)
    setError('')
    const response = await tracedFetch(name, `${apiBaseOf(direction)}/${id}${path}`, {
      method: options.method ?? 'POST',
      headers: options.idempotent ? idempotentJsonHeaders() : jsonHeaders(),
      body: JSON.stringify(body),
    })
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('actionFailed')))
      return false
    }
    await Promise.all([load(), onChanged()])
    return true
  }

  return (
    <Dialog.Root onOpenChange={(open) => (open ? undefined : onClose())} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup receivable-dialog">
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {failed ? <Notice copy={t('detailUnavailable')} /> : null}
          {!failed && !detail ? <LoadingState /> : null}
          {detail ? (
            <DetailBody
              abilities={abilities}
              busy={busy}
              command={command}
              data={data}
              detail={detail}
              setNotice={setNotice}
            />
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function DetailBody({
  detail,
  data,
  abilities,
  busy,
  command,
  setNotice,
}: {
  detail: TitleDetail
  data: TitlesData
  abilities: TitleAbilities
  busy: boolean
  command: Command
  setNotice: (value: string) => void
}) {
  const { direction } = data
  const t = useTranslations(namespaceOf(direction))
  const statusLabel = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  const status = displayStatus(detail)
  const section = { abilities, busy, command, detail, direction, setNotice }
  const category = data.categories.find((candidate) => candidate.id === detail.categoryId)
  return (
    <>
      <div className="dialog-heading receivable-heading">
        <Dialog.Title>{t('detailTitle', { document: detail.documentNumber })}</Dialog.Title>
        <Badge label={statusLabel(status)} status={status} />
      </div>
      <dl className="receivable-facts">
        <Fact label={t('counterparty')} value={detail.partyName ?? t('erasedParty')} />
        <Fact label={t('issuedOn')} value={date(`${detail.issuedOn}T12:00:00`)} />
        <Fact
          label={t('category')}
          value={category ? `${category.code} · ${category.name}` : t('noCategory')}
        />
        <Fact label={t('total')} value={money(detail.total, detail.currency)} />
        <Fact label={t('outstanding')} value={money(detail.outstanding, detail.currency)} />
        {detail.closureReason ? <Fact label={t('reason')} value={detail.closureReason} /> : null}
      </dl>
      {detail.status === 'draft' &&
      abilities.canRecord &&
      // Revising withdraws an approval, so a draft under review is not reclassified here.
      (detail.approvalState === 'none' || detail.approvalState === 'rejected') ? (
        <ClassifyForm
          busy={busy}
          categories={data.categories}
          detail={detail}
          direction={direction}
          onSubmit={async (terms) => {
            if (
              await command(`financial.${direction}.revise`, '', terms, {
                idempotent: false,
                method: 'PUT',
              })
            )
              setNotice(t('classified'))
          }}
        />
      ) : null}
      {direction === 'payable' && detail.status === 'draft' ? (
        <ApprovalSection {...section} required={approvalRequired(data, detail)} />
      ) : null}
      <TitleActions {...section} postable={postable(data, detail)} />
      <InstallmentsTable {...section} data={data} />
      <SettlementsTable {...section} data={data} />
      <Timeline detail={detail} direction={direction} />
    </>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

/** A payable that needs approval offers posting only once approved. */
function postable(data: TitlesData, detail: TitleDetail): boolean {
  return !approvalRequired(data, detail) || detail.approvalState === 'approved'
}

export type SectionProps = {
  direction: Direction
  detail: TitleDetail
  abilities: TitleAbilities
  busy: boolean
  command: Command
  setNotice: (value: string) => void
}

function TitleActions({
  direction,
  detail,
  abilities,
  busy,
  command,
  setNotice,
  postable: canPost,
}: SectionProps & { postable: boolean }) {
  const t = useTranslations(namespaceOf(direction))
  const [closing, setClosing] = useState(false)
  const draft = detail.status === 'draft'
  // Settlements in force are reversed first, so the title offers reversal only once none remain.
  const reversible =
    detail.status === 'posted' && detail.settlementState === 'open' && abilities.canReverse
  if (!(draft && abilities.canRecord) && !reversible) return null
  return (
    <div className="receivable-actions">
      {draft && abilities.canRecord && canPost ? (
        <Button
          disabled={busy}
          onClick={async () => {
            if (await command(`financial.${direction}.post`, '/post', {})) setNotice(t('posted'))
          }}
          type="button"
          variant="primary"
        >
          {t('post')}
        </Button>
      ) : null}
      {closing ? (
        <ReasonForm
          busy={busy}
          direction={direction}
          onCancel={() => setClosing(false)}
          onSubmit={async (reason) => {
            const done = draft
              ? await command(
                  `financial.${direction}.cancel`,
                  '/cancel',
                  { reason },
                  { idempotent: false },
                )
              : await command(`financial.${direction}.reverse`, '/reverse', { reason })
            if (done) {
              setClosing(false)
              setNotice(draft ? t('cancelled') : t('reversed'))
            }
          }}
          submitLabel={draft ? t('cancelDraft') : t('reverse')}
        />
      ) : (
        <Button disabled={busy} onClick={() => setClosing(true)} type="button" variant="danger">
          {draft ? t('cancelDraft') : t('reverse')}
        </Button>
      )}
    </div>
  )
}

function InstallmentsTable({
  direction,
  detail,
  data,
  abilities,
  busy,
  command,
  setNotice,
}: SectionProps & { data: TitlesData }) {
  const t = useTranslations(namespaceOf(direction))
  const statusLabel = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  const [settling, setSettling] = useState<Installment | null>(null)
  const settleable = detail.status === 'posted' && abilities.canRecord
  return (
    <section className="receivable-section">
      <h3>{t('installments')}</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('installment')}</th>
              <th>{t('dueOn')}</th>
              <th className="numeric">{t('amount')}</th>
              <th className="numeric">{t('outstanding')}</th>
              <th>{t('status')}</th>
              <th aria-label={t('installmentActions')} />
            </tr>
          </thead>
          <tbody>
            {detail.installments.map((installment) => (
              <tr key={installment.number}>
                <td>{installment.number}</td>
                <td>{date(`${installment.dueOn}T12:00:00`)}</td>
                <td className="numeric">{money(installment.amount, detail.currency)}</td>
                <td className="numeric">{money(installment.outstanding, detail.currency)}</td>
                <td>
                  <Badge label={statusLabel(installment.state)} status={installment.state} />
                </td>
                <td>
                  {settleable && installment.outstanding !== '0' ? (
                    <Button
                      aria-label={t('settleLabel', { number: installment.number })}
                      disabled={busy}
                      onClick={() => setSettling(installment)}
                      type="button"
                      variant="secondary"
                    >
                      {t('settle')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {settling ? (
        <SettleForm
          busy={busy}
          direction={direction}
          installment={settling}
          issuedOn={detail.issuedOn}
          onCancel={() => setSettling(null)}
          onSubmit={async (body) => {
            if (await command(`financial.${direction}.settle`, '/settlements', body)) {
              setSettling(null)
              setNotice(t('settled'))
            }
          }}
          paymentMethods={data.paymentMethods}
        />
      ) : null}
    </section>
  )
}

function SettlementsTable({
  direction,
  detail,
  data,
  abilities,
  busy,
  command,
  setNotice,
}: SectionProps & { data: TitlesData }) {
  const t = useTranslations(namespaceOf(direction))
  const statusLabel = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  const [reversing, setReversing] = useState<string | null>(null)
  if (!detail.settlements.length) return null
  return (
    <section className="receivable-section">
      <h3>{t('settlements')}</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('settledOn')}</th>
              <th>{t('installment')}</th>
              <th className="numeric">{t('received')}</th>
              <th className="numeric">{t('adjustments')}</th>
              <th>{t('paymentMethod')}</th>
              <th>{t('status')}</th>
              <th aria-label={t('settlementActions')} />
            </tr>
          </thead>
          <tbody>
            {detail.settlements.map((settlement) => {
              const state = settlement.reversedAt ? 'reversed' : 'recorded'
              const method = data.paymentMethods.find(
                (item) => item.id === settlement.paymentMethodId,
              )
              return (
                <tr key={settlement.id}>
                  <td>{date(`${settlement.settledOn}T12:00:00`)}</td>
                  <td>{settlement.installmentNumber}</td>
                  <td className="numeric">{money(settlement.received, detail.currency)}</td>
                  <td className="numeric">
                    {t('adjustmentSummary', {
                      discount: money(settlement.discount, detail.currency),
                      additions: money(
                        String(BigInt(settlement.interest) + BigInt(settlement.penalty)),
                        detail.currency,
                      ),
                    })}
                  </td>
                  <td>{method?.name ?? '—'}</td>
                  <td>
                    <Badge label={statusLabel(state)} status={state} />
                  </td>
                  <td>
                    {abilities.canReverse &&
                    !settlement.reversedAt &&
                    detail.status === 'posted' ? (
                      <Button
                        disabled={busy}
                        onClick={() => setReversing(settlement.id)}
                        type="button"
                        variant="ghost"
                      >
                        {t('reverseSettlement')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {reversing ? (
        <ReasonForm
          busy={busy}
          direction={direction}
          onCancel={() => setReversing(null)}
          onSubmit={async (reason) => {
            if (
              await command('financial.settlement.reverse', `/settlements/${reversing}/reverse`, {
                reason,
              })
            ) {
              setReversing(null)
              setNotice(t('settlementReversed'))
            }
          }}
          submitLabel={t('reverseSettlement')}
        />
      ) : null}
    </section>
  )
}

function Timeline({ detail, direction }: { detail: TitleDetail; direction: Direction }) {
  const t = useTranslations(namespaceOf(direction))
  const dateTime = useDateTime()
  return (
    <section className="receivable-section">
      <h3>{t('timeline')}</h3>
      <ol className="receivable-timeline">
        {detail.timeline.map((entry) => (
          <li key={entry.sequence}>
            <strong>
              {t.has(`action.${entry.action}`) ? t(`action.${entry.action}`) : entry.action}
            </strong>
            <small>{dateTime(entry.occurredAt)}</small>
          </li>
        ))}
      </ol>
    </section>
  )
}
