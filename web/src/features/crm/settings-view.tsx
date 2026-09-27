'use client'

import { ArrowDown, ArrowUp } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Resource } from '@/components/ui/resource'
import { Empty, Notice } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { useLoader } from '@/lib/use-loader'
import { type CrmDirectory, loadDirectory, newKey, send, useCrmAbilities } from './crm-data'
import type { ListEntry, Pipeline, Stage } from './types'

export function SettingsPage() {
  const t = useTranslations('crm')
  const abilities = useCrmAbilities()
  const state = useLoader(loadDirectory)
  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('settings.title')}</h1>
        <p className="catalog-page-copy">{t('settings.copy')}</p>
      </header>
      {abilities.canConfigure ? null : <Notice copy={t('settings.readOnly')} />}
      <Resource state={state}>
        {(data) => (
          <SettingsView
            canConfigure={abilities.canConfigure}
            data={data}
            onChanged={state.reload}
          />
        )}
      </Resource>
    </section>
  )
}

type Run = (
  name: string,
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  body: unknown,
  key?: boolean,
) => Promise<boolean>

/** Pipelines and their stages, sources and loss reasons (Phase 56). Nothing is deleted. */
function SettingsView({
  data,
  canConfigure,
  onChanged,
}: {
  data: CrmDirectory
  canConfigure: boolean
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const setNotice = useNotice()
  const [error, setError] = useState('')
  const run: Run = async (name, method, path, body, key = false) => {
    setError('')
    const result = await send(name, method, path, {
      body,
      ...(key ? { key: newKey() } : {}),
      fallback: t('settings.failed'),
    })
    if (!result.ok) {
      setError(result.error)
      return false
    }
    setNotice(t('settings.saved'))
    await onChanged()
    return true
  }
  return (
    <>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="crm-section">
        <h2>{t('settings.pipelines')}</h2>
        {canConfigure ? <NewPipelineForm run={run} /> : null}
        {data.pipelines.length === 0 ? (
          <Empty copy={t('pipeline.none')} />
        ) : (
          data.pipelines.map((pipeline) => (
            <PipelineSettings
              canConfigure={canConfigure}
              key={pipeline.id}
              pipeline={pipeline}
              run={run}
            />
          ))
        )}
      </section>
      <ListSettings canConfigure={canConfigure} entries={data.sources} kind="sources" run={run} />
      <ListSettings
        canConfigure={canConfigure}
        entries={data.lossReasons}
        kind="loss-reasons"
        run={run}
      />
    </>
  )
}

function percentToBps(value: FormDataEntryValue | null): number {
  return Math.round(Number(String(value ?? '0').replace(',', '.')) * 100)
}

function NewPipelineForm({ run }: { run: Run }) {
  const t = useTranslations('crm')
  const [round, setRound] = useState(0)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const created = await run(
      'crm.pipeline.create',
      'POST',
      '/pipelines',
      {
        name: form.get('name'),
        stages: [
          { name: form.get('stage'), probabilityBps: percentToBps(form.get('probability')) },
        ],
      },
      true,
    )
    if (created) setRound((value) => value + 1)
  }
  return (
    <form className="crm-form-row crm-inline-form" key={round} onSubmit={submit}>
      <TextField label={t('settings.pipelineName')} maxLength={80} name="name" required />
      <TextField label={t('settings.firstStage')} maxLength={80} name="stage" required />
      <TextField
        defaultValue="10"
        label={t('settings.probability')}
        max={100}
        min={0}
        name="probability"
        required
        step="0.01"
        type="number"
      />
      <Button type="submit" variant="primary">
        {t('settings.createPipeline')}
      </Button>
    </form>
  )
}

function PipelineSettings({
  pipeline,
  canConfigure,
  run,
}: {
  pipeline: Pipeline
  canConfigure: boolean
  run: Run
}) {
  const t = useTranslations('crm')
  const stages = [...pipeline.stages].sort((a, b) => a.position - b.position)
  const base = `/pipelines/${pipeline.id}`

  function reorder(index: number, step: -1 | 1) {
    const ids = stages.map((stage) => stage.id)
    const [moved] = ids.splice(index, 1)
    if (!moved) return
    ids.splice(index + step, 0, moved)
    void run('crm.pipeline.reorder', 'PUT', `${base}/stage-order`, { stageIds: ids })
  }

  async function addStage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const element = event.currentTarget
    const form = new FormData(element)
    if (
      await run('crm.pipeline.stage.add', 'POST', `${base}/stages`, {
        name: form.get('name'),
        probabilityBps: percentToBps(form.get('probability')),
      })
    )
      element.reset()
  }

  return (
    <article className="panel crm-settings-card" aria-label={pipeline.name}>
      <header className="crm-settings-heading">
        <h3>
          {pipeline.name}{' '}
          {pipeline.archived ? <Badge label={t('settings.archived')} status="inactive" /> : null}
        </h3>
        {canConfigure ? (
          <Button
            onClick={() =>
              run('crm.pipeline.archive', 'PATCH', `${base}/status`, {
                archived: !pipeline.archived,
              })
            }
            variant="ghost"
          >
            {pipeline.archived ? t('settings.restore') : t('settings.archive')}
          </Button>
        ) : null}
      </header>
      <ol className="crm-stage-list">
        {stages.map((stage, index) => (
          <StageRow
            canConfigure={canConfigure}
            first={index === 0}
            key={stage.id}
            last={index === stages.length - 1}
            onDown={() => reorder(index, 1)}
            onUp={() => reorder(index, -1)}
            path={`${base}/stages/${stage.id}`}
            run={run}
            stage={stage}
          />
        ))}
      </ol>
      {canConfigure ? (
        <form className="crm-form-row crm-inline-form" onSubmit={addStage}>
          <TextField label={t('settings.stageName')} maxLength={80} name="name" required />
          <TextField
            defaultValue="50"
            label={t('settings.probability')}
            max={100}
            min={0}
            name="probability"
            required
            step="0.01"
            type="number"
          />
          <Button type="submit" variant="secondary">
            {t('settings.addStage')}
          </Button>
        </form>
      ) : null}
    </article>
  )
}

function StageRow({
  stage,
  path,
  first,
  last,
  canConfigure,
  onUp,
  onDown,
  run,
}: {
  stage: Stage
  path: string
  first: boolean
  last: boolean
  canConfigure: boolean
  onUp: () => void
  onDown: () => void
  run: Run
}) {
  const t = useTranslations('crm')
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void run('crm.pipeline.stage.revise', 'PATCH', path, {
      name: form.get('name'),
      probabilityBps: percentToBps(form.get('probability')),
    })
  }
  if (!canConfigure)
    return (
      <li className="crm-stage-row">
        {stage.name} · {stage.probabilityBps / 100}%
        {stage.archived ? ` · ${t('settings.archived')}` : ''}
      </li>
    )
  return (
    <li className="crm-stage-row">
      <form className="crm-form-row crm-inline-form" onSubmit={save}>
        <TextField
          defaultValue={stage.name}
          label={t('settings.stageName')}
          maxLength={80}
          name="name"
          required
        />
        <TextField
          defaultValue={String(stage.probabilityBps / 100)}
          label={t('settings.probability')}
          max={100}
          min={0}
          name="probability"
          required
          step="0.01"
          type="number"
        />
        <Button type="submit" variant="secondary">
          {t('settings.save')}
        </Button>
        <Button
          aria-label={t('settings.moveUp', { stage: stage.name })}
          disabled={first}
          onClick={onUp}
          variant="ghost"
        >
          <ArrowUp aria-hidden="true" size={16} />
        </Button>
        <Button
          aria-label={t('settings.moveDown', { stage: stage.name })}
          disabled={last}
          onClick={onDown}
          variant="ghost"
        >
          <ArrowDown aria-hidden="true" size={16} />
        </Button>
        <Button
          onClick={() =>
            run('crm.pipeline.stage.archive', 'PATCH', path, { archived: !stage.archived })
          }
          variant="ghost"
        >
          {stage.archived ? t('settings.restore') : t('settings.archive')}
        </Button>
      </form>
    </li>
  )
}

function ListSettings({
  kind,
  entries,
  canConfigure,
  run,
}: {
  kind: 'sources' | 'loss-reasons'
  entries: readonly ListEntry[]
  canConfigure: boolean
  run: Run
}) {
  const t = useTranslations('crm')
  const [round, setRound] = useState(0)
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (await run(`crm.${kind}.create`, 'POST', `/${kind}`, { name: form.get('name') }, true))
      setRound((value) => value + 1)
  }
  return (
    <section aria-label={t(`settings.${kind}`)} className="crm-section">
      <h2>{t(`settings.${kind}`)}</h2>
      {canConfigure ? (
        <form className="crm-form-row crm-inline-form" key={round} onSubmit={create}>
          <TextField label={t('settings.entryName')} maxLength={80} name="name" required />
          <Button type="submit" variant="primary">
            {t('settings.addEntry')}
          </Button>
        </form>
      ) : null}
      {entries.length === 0 ? (
        <Empty copy={t('settings.noEntries')} />
      ) : (
        <ul className="crm-stage-list">
          {entries.map((entry) => (
            <li className="crm-stage-row" key={entry.id}>
              {canConfigure ? (
                <form
                  className="crm-form-row crm-inline-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void run(`crm.${kind}.rename`, 'PATCH', `/${kind}/${entry.id}`, {
                      name: new FormData(event.currentTarget).get('name'),
                    })
                  }}
                >
                  <TextField
                    defaultValue={entry.name}
                    label={t('settings.entryName')}
                    maxLength={80}
                    name="name"
                    required
                  />
                  <Button type="submit" variant="secondary">
                    {t('settings.save')}
                  </Button>
                  <Button
                    onClick={() =>
                      run(`crm.${kind}.archive`, 'PATCH', `/${kind}/${entry.id}`, {
                        archived: !entry.archived,
                      })
                    }
                    variant="ghost"
                  >
                    {entry.archived ? t('settings.restore') : t('settings.archive')}
                  </Button>
                </form>
              ) : (
                <>
                  {entry.name}
                  {entry.archived ? ` · ${t('settings.archived')}` : ''}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
