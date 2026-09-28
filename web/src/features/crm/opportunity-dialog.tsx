'use client'

import { Dialog } from '@base-ui/react/dialog'
import { X } from '@phosphor-icons/react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { LoadingState, Notice } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { AttachmentsPanel } from '@/features/attachments/attachments-panel'
import { reference } from '@/features/sales/types'
import { useDate, useMoney } from '@/lib/use-format'
import { ConvertDialog } from './convert-dialog'
import { type CrmAbilities, type CrmDirectory, readCrm, send } from './crm-data'
import { RecordForms } from './record-forms'
import { Timeline } from './timeline'
import {
  type Account,
  accountName,
  activeStages,
  type Contact,
  type OpportunityDetail,
  personLabel,
  type TimelineEntry,
} from './types'

type Loaded = {
  detail: OpportunityDetail
  account: (Account & { contacts: Contact[] }) | null
  timeline: TimelineEntry[]
}

async function loadOpportunity(id: string): Promise<Loaded> {
  const detail = await readCrm<OpportunityDetail>('crm.opportunity', `/opportunities/${id}`)
  const [account, timeline] = await Promise.all([
    readCrm<Account & { contacts: Contact[] }>(
      'crm.account',
      `/accounts/${detail.accountId}`,
    ).catch(() => null),
    readCrm<{ data: TimelineEntry[] }>(
      'crm.opportunity.timeline',
      `/opportunities/${id}/timeline?limit=100`,
    ),
  ])
  return { detail, account, timeline: timeline.data }
}

/**
 * One opportunity: where it stands, the quotes made for it, what can be done with it, and
 * everything that happened around it (Phases 56–58).
 */
export function OpportunityDialog({
  opportunityId,
  directory,
  abilities,
  onClose,
  onChanged,
}: {
  opportunityId: string
  directory: CrmDirectory
  abilities: CrmAbilities
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const common = useTranslations('common')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState(false)
  const [converting, setConverting] = useState(false)

  const load = useCallback(async () => {
    try {
      setLoaded(await loadOpportunity(opportunityId))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [opportunityId])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = async () => {
    await Promise.all([load(), onChanged()])
  }

  return (
    <Dialog.Root onOpenChange={(open) => (open ? undefined : onClose())} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup document-dialog crm-dialog">
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {failed ? <Notice copy={t('opportunity.unavailable')} /> : null}
          {!failed && !loaded ? <LoadingState /> : null}
          {loaded ? (
            <>
              <Summary directory={directory} loaded={loaded} />
              <Actions
                abilities={abilities}
                directory={directory}
                loaded={loaded}
                onConvert={() => setConverting(true)}
                refresh={refresh}
              />
              {abilities.canWrite ? (
                <section className="crm-section">
                  <h3>{t('records.heading')}</h3>
                  <RecordForms
                    canAssign={abilities.canAssign}
                    contacts={loaded.account?.contacts ?? []}
                    directory={directory}
                    onRecorded={refresh}
                    subject={{ type: 'opportunity', id: loaded.detail.id }}
                    userId={abilities.userId}
                  />
                </section>
              ) : null}
              <section className="crm-section">
                <h3>{t('timeline.title')}</h3>
                <Timeline directory={directory} entries={loaded.timeline} />
              </section>
              <AttachmentsPanel
                record={{
                  module: 'crm',
                  recordType: 'opportunity',
                  recordId: loaded.detail.id,
                  ownerPartyId: loaded.detail.accountId,
                }}
              />
              {converting && loaded.account ? (
                <ConvertDialog
                  account={loaded.account}
                  onClose={() => setConverting(false)}
                  onConverted={refresh}
                  opportunity={loaded.detail}
                />
              ) : null}
            </>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Summary({ loaded, directory }: { loaded: Loaded; directory: CrmDirectory }) {
  const t = useTranslations('crm')
  const money = useMoney()
  const date = useDate()
  const { detail } = loaded
  const pipeline = directory.pipelines.find((row) => row.id === detail.pipelineId)
  const stage = pipeline?.stages.find((row) => row.id === detail.stageId)
  const source = directory.sources.find((row) => row.id === detail.sourceId)
  const reason = directory.lossReasons.find((row) => row.id === detail.lossReasonId)
  return (
    <>
      <div className="dialog-heading">
        <Dialog.Title>{detail.title}</Dialog.Title>
        <Badge label={t(`opportunityStatus.${detail.status}`)} status={detail.status} />
      </div>
      <dl className="document-facts">
        <div>
          <dt>{t('table.account')}</dt>
          <dd>{accountName(loaded.account ?? undefined, t('unknownAccount'))}</dd>
        </div>
        <div>
          <dt>{t('table.stage')}</dt>
          <dd>
            {pipeline?.name} · {stage?.name} ({detail.probabilityBps / 100}%)
          </dd>
        </div>
        <div>
          <dt>{t('table.value')}</dt>
          <dd>{money(detail.expectedValue.amount, detail.expectedValue.currency)}</dd>
        </div>
        <div>
          <dt>{detail.closedOn ? t('opportunity.closedOn') : t('table.closeOn')}</dt>
          <dd>{date(detail.closedOn ?? detail.expectedCloseOn)}</dd>
        </div>
        <div>
          <dt>{t('table.owner')}</dt>
          <dd>{personLabel(directory.names, detail.ownerId, t('noOwner'))}</dd>
        </div>
        <div>
          <dt>{t('opportunity.source')}</dt>
          <dd>{source?.name ?? t('opportunity.noSource')}</dd>
        </div>
        {reason ? (
          <div>
            <dt>{t('opportunity.lossReason')}</dt>
            <dd>
              {reason.name}
              {detail.lossNote ? ` · ${detail.lossNote}` : ''}
            </dd>
          </div>
        ) : null}
      </dl>
      {detail.conversion ? (
        <p className="crm-conversion">
          {t('opportunity.converted', { quote: reference('QT', detail.conversion.quoteRoot) })}{' '}
          <Link href={`/app/sales/quotes?open=${detail.conversion.quoteId}`}>
            {t('opportunity.openQuote')}
          </Link>
        </p>
      ) : null}
      {detail.quotes.length ? (
        <section className="crm-section">
          <h3>{t('opportunity.quotes')}</h3>
          <ul className="crm-quote-list">
            {detail.quotes.map((quote) => (
              <li key={quote.quoteRoot}>
                <Link href={`/app/sales/quotes?open=${quote.quoteId}`}>
                  {reference('QT', quote.quoteRoot)} · v{quote.quoteVersion}
                </Link>{' '}
                · {t(`quoteStatus.${quote.status}`)}
                {quote.total ? ` · ${money(quote.total.amount, quote.total.currency)}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}

type RunAction = (name: string, path: string, body?: unknown) => Promise<void>

function Actions({
  loaded,
  directory,
  abilities,
  onConvert,
  refresh,
}: {
  loaded: Loaded
  directory: CrmDirectory
  abilities: CrmAbilities
  onConvert: () => void
  refresh: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { detail } = loaded
  if (!abilities.canWrite) return null
  const pipeline = directory.pipelines.find((row) => row.id === detail.pipelineId)
  const stages = (pipeline ? activeStages(pipeline) : []).filter(
    (row) => row.id !== detail.stageId || detail.status !== 'open',
  )

  const run: RunAction = async (name, path, body) => {
    setBusy(true)
    setError('')
    const result = await send(name, 'POST', `/opportunities/${detail.id}/${path}`, {
      body,
      fallback: t('opportunity.failed'),
    })
    setBusy(false)
    if (result.ok) await refresh()
    else setError(result.error)
  }

  const stageOptions = stages.map((row) => ({ label: row.name, value: row.id }))
  return (
    <section className="crm-section crm-actions">
      <h3>{t('opportunity.actions')}</h3>
      {detail.status === 'open' ? (
        <OpenActions
          abilities={abilities}
          busy={busy}
          canConvert={loaded.account?.status === 'active'}
          detail={detail}
          directory={directory}
          onConvert={onConvert}
          run={run}
          stageOptions={stageOptions}
        />
      ) : detail.conversion ? (
        <p className="crm-hint">{t('opportunity.convertedFinal')}</p>
      ) : (
        <StageAction
          busy={busy}
          label={t('opportunity.reopenIn')}
          name="reopenStageId"
          onRun={(stageId) => run('crm.opportunity.reopen', 'reopen', { stageId })}
          options={stageOptions}
          submit={t('opportunity.reopen')}
        />
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

/** Choose a stage and act on it: move an open opportunity, or reopen a closed one there. */
function StageAction({
  label,
  name,
  submit,
  options,
  busy,
  onRun,
}: {
  label: string
  name: string
  submit: string
  options: { label: string; value: string }[]
  busy: boolean
  onRun: (stageId: string) => Promise<void>
}) {
  const [stageId, setStageId] = useState<string | null>(null)
  const chosen = stageId ?? options[0]?.value ?? null
  return (
    <div className="crm-action-row">
      <SelectField
        label={label}
        name={name}
        onValueChange={setStageId}
        options={options}
        value={chosen}
      />
      <Button
        disabled={busy || !chosen}
        onClick={() => (chosen ? onRun(chosen) : undefined)}
        variant="secondary"
      >
        {submit}
      </Button>
    </div>
  )
}

function OpenActions({
  detail,
  directory,
  abilities,
  stageOptions,
  busy,
  canConvert,
  onConvert,
  run,
}: {
  detail: OpportunityDetail
  directory: CrmDirectory
  abilities: CrmAbilities
  stageOptions: { label: string; value: string }[]
  busy: boolean
  canConvert: boolean
  onConvert: () => void
  run: RunAction
}) {
  const t = useTranslations('crm')
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [reasonId, setReasonId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const reasons = directory.lossReasons.filter((row) => !row.archived)
  const owners = directory.owners.filter((row) => row.active && row.userId !== detail.ownerId)
  const owner = ownerId ?? owners[0]?.userId ?? null
  const reason = reasonId ?? reasons[0]?.id ?? null
  return (
    <>
      <StageAction
        busy={busy}
        label={t('opportunity.moveTo')}
        name="stageId"
        onRun={(stageId) => run('crm.opportunity.move', 'stage', { stageId })}
        options={stageOptions}
        submit={t('opportunity.move')}
      />
      {abilities.canAssign && owners.length ? (
        <div className="crm-action-row">
          <SelectField
            label={t('opportunity.reassignTo')}
            name="ownerId"
            onValueChange={setOwnerId}
            options={owners.map((row) => ({
              label: personLabel(directory.names, row.userId, t('noOwner')),
              value: row.userId,
            }))}
            value={owner}
          />
          <Button
            disabled={busy}
            onClick={() => run('crm.opportunity.reassign', 'owner', { ownerId: owner })}
            variant="secondary"
          >
            {t('opportunity.reassign')}
          </Button>
        </div>
      ) : null}
      <div className="crm-action-row">
        <SelectField
          label={t('opportunity.lossReason')}
          name="lossReasonId"
          onValueChange={setReasonId}
          options={reasons.map((row) => ({ label: row.name, value: row.id }))}
          value={reason}
        />
        <TextField
          label={t('opportunity.lossNote')}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
          value={note}
        />
        <Button
          disabled={busy || !reason}
          onClick={() =>
            run('crm.opportunity.lose', 'lose', { lossReasonId: reason, note: note || null })
          }
          variant="danger"
        >
          {t('opportunity.lose')}
        </Button>
      </div>
      <div className="dialog-actions">
        <Button
          disabled={busy}
          onClick={() => run('crm.opportunity.win', 'win')}
          variant="secondary"
        >
          {t('opportunity.win')}
        </Button>
        {canConvert ? (
          <Button disabled={busy} onClick={onConvert} variant="primary">
            {t('opportunity.convert')}
          </Button>
        ) : null}
      </div>
    </>
  )
}
