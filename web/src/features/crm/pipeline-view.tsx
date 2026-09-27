'use client'

import { useTranslations } from 'next-intl'
import { type DragEvent, type KeyboardEvent, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Resource } from '@/components/ui/resource'
import { SelectField } from '@/components/ui/select-field'
import { Empty } from '@/components/ui/state'
import { useUrlParam } from '@/lib/url-param'
import { useDate, useMoney } from '@/lib/use-format'
import { useLoader } from '@/lib/use-loader'
import {
  type CrmAbilities,
  loadPipelineData,
  type PipelineData,
  send,
  useCrmAbilities,
} from './crm-data'
import { NewOpportunityDialog } from './new-opportunity-dialog'
import { OpportunityDialog } from './opportunity-dialog'
import {
  accountName,
  boardStages,
  neighbourStage,
  type Opportunity,
  type Pipeline,
  personLabel,
} from './types'

export function PipelinePage() {
  const abilities = useCrmAbilities()
  const state = useLoader(loadPipelineData)
  return (
    <Resource state={state}>
      {(data) => <PipelineView abilities={abilities} data={data} onChanged={state.reload} />}
    </Resource>
  )
}

type Mode = 'board' | 'table'

/**
 * The opportunities of one pipeline, stage by stage (Phase 60). A card moves by dragging it
 * to another column or with the arrow keys; the table lists every opportunity, won and lost
 * included.
 */
function PipelineView({
  data,
  abilities,
  onChanged,
}: {
  data: PipelineData
  abilities: CrmAbilities
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const usable = data.pipelines.filter((pipeline) => !pipeline.archived)
  const [pipelineId, setPipelineId] = useState<string | null>(usable[0]?.id ?? null)
  const [mode, setMode] = useState<Mode>('board')
  const [openId, setOpenId] = useState<string | null>(null)
  const openParam = useUrlParam('open')
  useEffect(() => {
    if (openParam) setOpenId(openParam)
  }, [openParam])
  const pipeline = data.pipelines.find((row) => row.id === pipelineId) ?? usable[0] ?? null
  const rows = data.opportunities.filter((row) => row.pipelineId === pipeline?.id)

  return (
    <section>
      <header className="page-heading page-heading-with-actions">
        <div>
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{t('pipeline.title')}</h1>
          <p className="catalog-page-copy">{t('pipeline.copy')}</p>
        </div>
        <div className="page-actions">
          {abilities.canWrite && pipeline ? (
            <NewOpportunityDialog
              data={data}
              onChanged={onChanged}
              pipeline={pipeline}
              userId={abilities.userId}
            />
          ) : null}
        </div>
      </header>
      {!pipeline ? (
        <Empty copy={t('pipeline.none')} />
      ) : (
        <>
          <div className="crm-toolbar">
            <SelectField
              label={t('pipeline.choose')}
              name="pipelineId"
              onValueChange={(value) => setPipelineId(value)}
              options={usable.map((row) => ({ label: row.name, value: row.id }))}
              value={pipeline.id}
            />
            <fieldset className="crm-segmented">
              <legend className="sr-only">{t('pipeline.view')}</legend>
              {(['board', 'table'] as const).map((option) => (
                <Button
                  aria-pressed={mode === option}
                  key={option}
                  onClick={() => setMode(option)}
                  variant={mode === option ? 'primary' : 'secondary'}
                >
                  {t(`pipeline.mode.${option}`)}
                </Button>
              ))}
            </fieldset>
          </div>
          {mode === 'board' ? (
            <PipelineBoard
              canMove={abilities.canWrite}
              data={data}
              onChanged={onChanged}
              onOpen={setOpenId}
              pipeline={pipeline}
              rows={rows.filter((row) => row.status === 'open')}
            />
          ) : (
            <OpportunityTable data={data} onOpen={setOpenId} pipeline={pipeline} rows={rows} />
          )}
        </>
      )}
      {openId ? (
        <OpportunityDialog
          abilities={abilities}
          directory={data}
          onChanged={onChanged}
          onClose={() => setOpenId(null)}
          opportunityId={openId}
        />
      ) : null}
    </section>
  )
}

function PipelineBoard({
  pipeline,
  rows,
  data,
  canMove,
  onOpen,
  onChanged,
}: {
  pipeline: Pipeline
  rows: readonly Opportunity[]
  data: PipelineData
  canMove: boolean
  onOpen: (id: string) => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const money = useMoney()
  const [announcement, setAnnouncement] = useState('')
  const [error, setError] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  const columns = boardStages(pipeline, rows)
  const accounts = useMemo(
    () => new Map(data.accounts.map((row) => [row.id, row])),
    [data.accounts],
  )

  async function move(row: Opportunity, stageId: string) {
    if (!canMove || stageId === row.stageId) return
    const stage = pipeline.stages.find((candidate) => candidate.id === stageId)
    if (!stage || stage.archived) return
    setError('')
    const result = await send('crm.opportunity.move', 'POST', `/opportunities/${row.id}/stage`, {
      body: { stageId },
      fallback: t('pipeline.moveFailed'),
    })
    if (!result.ok) {
      setError(result.error)
      return
    }
    setAnnouncement(t('pipeline.moved', { title: row.title, stage: stage.name }))
    await onChanged()
  }

  function onKey(event: KeyboardEvent<HTMLButtonElement>, row: Opportunity) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const next = neighbourStage(
      pipeline,
      row.stageId,
      event.key === 'ArrowRight' ? 'next' : 'previous',
    )
    if (next) void move(row, next.id)
  }

  function onDrop(event: DragEvent<HTMLElement>, stageId: string) {
    event.preventDefault()
    setTarget(null)
    const row = rows.find((candidate) => candidate.id === event.dataTransfer.getData('text/plain'))
    if (row) void move(row, stageId)
  }

  return (
    <>
      {canMove ? (
        <p className="crm-hint" id="crm-board-hint">
          {t('pipeline.keyboardHint')}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="board crm-board">
        {columns.map((stage) => {
          const cards = rows.filter((row) => row.stageId === stage.id)
          const total = sumByCurrency(cards)
          return (
            <section
              aria-label={stage.name}
              className={`board-column${target === stage.id ? ' crm-drop-target' : ''}`}
              key={stage.id}
              onDragLeave={() => setTarget(null)}
              onDragOver={(event) => {
                if (!canMove || stage.archived) return
                event.preventDefault()
                setTarget(stage.id)
              }}
              onDrop={(event) => onDrop(event, stage.id)}
            >
              <header className="board-column-heading">
                <h2>
                  {stage.name}
                  {stage.archived ? ` · ${t('pipeline.archivedStage')}` : ''}
                </h2>
                <span className="board-count">{cards.length}</span>
              </header>
              <p className="crm-column-meta">
                {t('pipeline.probability', { percent: stage.probabilityBps / 100 })}
                {total.map(([currency, amount]) => ` · ${money(amount, currency)}`).join('')}
              </p>
              {cards.length === 0 ? (
                <p className="board-empty">{t('pipeline.columnEmpty')}</p>
              ) : (
                <ul className="board-cards">
                  {cards.map((row) => (
                    <li key={row.id}>
                      <button
                        aria-describedby={canMove ? 'crm-board-hint' : undefined}
                        aria-label={t('pipeline.open', { title: row.title })}
                        className="board-card"
                        draggable={canMove}
                        onClick={() => onOpen(row.id)}
                        onDragStart={(event) => event.dataTransfer.setData('text/plain', row.id)}
                        onKeyDown={(event) => onKey(event, row)}
                        type="button"
                      >
                        <strong className="board-card-title">{row.title}</strong>
                        <span className="board-card-line">
                          {accountName(accounts.get(row.accountId), t('unknownAccount'))}
                        </span>
                        <span className="board-card-line">
                          {money(row.expectedValue.amount, row.expectedValue.currency)}
                        </span>
                        <span className="board-card-line">
                          {personLabel(data.names, row.ownerId, t('noOwner'))}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </>
  )
}

function sumByCurrency(rows: readonly Opportunity[]): [string, string][] {
  const totals = new Map<string, bigint>()
  for (const row of rows)
    totals.set(
      row.expectedValue.currency,
      (totals.get(row.expectedValue.currency) ?? 0n) + BigInt(row.expectedValue.amount),
    )
  return [...totals.entries()].map(([currency, amount]) => [currency, amount.toString()])
}

function OpportunityTable({
  pipeline,
  rows,
  data,
  onOpen,
}: {
  pipeline: Pipeline
  rows: readonly Opportunity[]
  data: PipelineData
  onOpen: (id: string) => void
}) {
  const t = useTranslations('crm')
  const money = useMoney()
  const date = useDate()
  const [status, setStatus] = useState('all')
  const stages = new Map(pipeline.stages.map((stage) => [stage.id, stage.name]))
  const accounts = new Map(data.accounts.map((row) => [row.id, row]))
  const shown = rows.filter((row) => status === 'all' || row.status === status)
  return (
    <>
      <div className="crm-toolbar">
        <SelectField
          label={t('table.status')}
          name="status"
          onValueChange={(value) => setStatus(value ?? 'all')}
          options={['all', 'open', 'won', 'lost'].map((value) => ({
            label: t(`opportunityStatus.${value}`),
            value,
          }))}
          value={status}
        />
      </div>
      {shown.length === 0 ? (
        <Empty copy={t('table.empty')} />
      ) : (
        <div className="panel table-panel table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('table.title')}</th>
                <th>{t('table.account')}</th>
                <th>{t('table.stage')}</th>
                <th>{t('table.value')}</th>
                <th>{t('table.closeOn')}</th>
                <th>{t('table.owner')}</th>
                <th>{t('table.status')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button
                      className="crm-link-button"
                      onClick={() => onOpen(row.id)}
                      type="button"
                    >
                      {row.title}
                    </button>
                  </td>
                  <td>{accountName(accounts.get(row.accountId), t('unknownAccount'))}</td>
                  <td>{stages.get(row.stageId) ?? row.stageId.slice(0, 8)}</td>
                  <td>{money(row.expectedValue.amount, row.expectedValue.currency)}</td>
                  <td>{date(row.closedOn ?? row.expectedCloseOn)}</td>
                  <td>{personLabel(data.names, row.ownerId, t('noOwner'))}</td>
                  <td>
                    <Badge label={t(`opportunityStatus.${row.status}`)} status={row.status} />
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
