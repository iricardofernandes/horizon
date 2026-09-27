'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useCallback, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Stat } from '@/components/ui/headings'
import { Resource } from '@/components/ui/resource'
import { SelectField } from '@/components/ui/select-field'
import { Empty } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { useDateTime, useMoney } from '@/lib/use-format'
import { useLoader } from '@/lib/use-loader'
import { type CrmDirectory, loadDirectory, readCrm } from './crm-data'
import {
  durationParts,
  type ForecastRow,
  instantFromLocal,
  localInputOf,
  type PipelineMetrics,
  personLabel,
} from './types'

type Grouping = 'pipeline' | 'owner' | 'source'
/** `cutoff: null` asks for now, on the server's clock. */
type Query = { cutoff: string | null; groupBy: Grouping; pipelineId: string | null }
type Loaded = {
  directory: CrmDirectory
  forecast: { cutoff: string; settled: boolean; data: ForecastRow[] }
  metrics: PipelineMetrics | null
}

/**
 * The forecast and the pipeline metrics as of a cutoff (Phase 59). A settled cutoff is old
 * enough that its numbers can no longer change; a recent one says so.
 */
export function ForecastPage() {
  const t = useTranslations('crm')
  const [query, setQuery] = useState<Query>({
    cutoff: null,
    groupBy: 'pipeline',
    pipelineId: null,
  })
  const load = useCallback(async (): Promise<Loaded> => {
    const directory = await loadDirectory()
    const pipelineId =
      query.pipelineId ?? directory.pipelines.find((row) => !row.archived)?.id ?? null
    const at = query.cutoff ? `cutoff=${encodeURIComponent(query.cutoff)}&` : ''
    const [forecast, metrics] = await Promise.all([
      readCrm<Loaded['forecast']>('crm.forecast', `/forecast?${at}groupBy=${query.groupBy}`),
      pipelineId
        ? readCrm<PipelineMetrics>('crm.pipeline.metrics', `/pipelines/${pipelineId}/metrics?${at}`)
        : Promise.resolve(null),
    ])
    return { directory, forecast, metrics }
  }, [query])
  const state = useLoader(load)

  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('forecast.title')}</h1>
        <p className="catalog-page-copy">{t('forecast.copy')}</p>
      </header>
      <Resource state={state}>
        {(data) => <ForecastView data={data} onQuery={setQuery} query={query} />}
      </Resource>
    </section>
  )
}

function ForecastView({
  data,
  query,
  onQuery,
}: {
  data: Loaded
  query: Query
  onQuery: (query: Query) => void
}) {
  const t = useTranslations('crm')
  const when = useDateTime()
  const pipelines = data.directory.pipelines.filter((row) => !row.archived)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    onQuery({
      cutoff: instantFromLocal(String(form.get('cutoff') ?? '')),
      groupBy: (String(form.get('groupBy') ?? 'pipeline') as Grouping) || 'pipeline',
      pipelineId: String(form.get('pipelineId') ?? '') || null,
    })
  }

  return (
    <>
      <form className="crm-toolbar" key={JSON.stringify(query)} onSubmit={submit}>
        <TextField
          defaultValue={query.cutoff ? localInputOf(new Date(query.cutoff)) : ''}
          description={t('forecast.cutoffHelp')}
          label={t('forecast.cutoff')}
          name="cutoff"
          type="datetime-local"
        />
        <SelectField
          defaultValue={query.groupBy}
          label={t('forecast.groupBy')}
          name="groupBy"
          options={(['pipeline', 'owner', 'source'] as const).map((value) => ({
            label: t(`forecast.by.${value}`),
            value,
          }))}
        />
        <SelectField
          defaultValue={query.pipelineId ?? pipelines[0]?.id ?? null}
          label={t('forecast.metricsPipeline')}
          name="pipelineId"
          options={pipelines.map((row) => ({ label: row.name, value: row.id }))}
        />
        <Button type="submit" variant="primary">
          {t('forecast.apply')}
        </Button>
      </form>
      <p className="crm-hint">
        {t('forecast.asOf', { cutoff: when(data.forecast.cutoff) })}{' '}
        <Badge
          label={data.forecast.settled ? t('forecast.settled') : t('forecast.provisional')}
          status={data.forecast.settled ? 'settled' : 'pending'}
        />
      </p>
      <ForecastTable data={data} groupBy={query.groupBy} />
      {data.metrics ? <Metrics directory={data.directory} metrics={data.metrics} /> : null}
    </>
  )
}

function ForecastTable({ data, groupBy }: { data: Loaded; groupBy: Grouping }) {
  const t = useTranslations('crm')
  const money = useMoney()
  const { directory } = data
  const labelOf = (key: string | null): string => {
    if (groupBy === 'pipeline')
      return directory.pipelines.find((row) => row.id === key)?.name ?? '—'
    if (groupBy === 'owner') return personLabel(directory.names, key, t('noOwner'))
    return directory.sources.find((row) => row.id === key)?.name ?? t('opportunity.noSource')
  }
  return (
    <section className="crm-section">
      <h2>{t('forecast.forecast')}</h2>
      {data.forecast.data.length === 0 ? (
        <Empty copy={t('forecast.empty')} />
      ) : (
        <div className="panel table-panel table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('forecast.month')}</th>
                <th>{t(`forecast.by.${groupBy}`)}</th>
                <th className="numeric">{t('forecast.open')}</th>
                <th className="numeric">{t('forecast.weighted')}</th>
                <th className="numeric">{t('forecast.won')}</th>
              </tr>
            </thead>
            <tbody>
              {data.forecast.data.map((row) => (
                <tr key={`${row.month}-${row.key}-${row.currency}`}>
                  <td>{row.month}</td>
                  <td>{labelOf(row.key)}</td>
                  <td className="numeric">
                    {money(row.openValue, row.currency)} ({row.openCount})
                  </td>
                  <td className="numeric">{money(row.weightedValue, row.currency)}</td>
                  <td className="numeric">
                    {money(row.wonValue, row.currency)} ({row.wonCount})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Metrics({ metrics, directory }: { metrics: PipelineMetrics; directory: CrmDirectory }) {
  const t = useTranslations('crm')
  const stages = new Map(
    directory.pipelines.flatMap((row) => row.stages).map((stage) => [stage.id, stage.name]),
  )
  const reasons = new Map(directory.lossReasons.map((row) => [row.id, row.name]))
  const duration = (seconds: number) => {
    const parts = durationParts(seconds)
    return t(`forecast.duration.${parts.unit}`, { value: parts.value })
  }
  const rate = metrics.outcomes.winRateBps === null ? '—' : `${metrics.outcomes.winRateBps / 100}%`
  return (
    <section aria-label={t('forecast.metrics')} className="crm-section">
      <h2>{t('forecast.metrics')}</h2>
      <div className="stat-grid">
        <Stat
          label={t('forecast.winRate')}
          note={t('forecast.decided', { won: metrics.outcomes.won, lost: metrics.outcomes.lost })}
          value={rate}
        />
      </div>
      {metrics.stages.length === 0 ? (
        <Empty copy={t('forecast.noMetrics')} />
      ) : (
        <div className="panel table-panel table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('table.stage')}</th>
                <th className="numeric">{t('forecast.entered')}</th>
                <th className="numeric">{t('forecast.current')}</th>
                <th className="numeric">{t('forecast.moved')}</th>
                <th className="numeric">{t('forecast.wonExit')}</th>
                <th className="numeric">{t('forecast.lostExit')}</th>
                <th className="numeric">{t('forecast.averageTime')}</th>
                <th className="numeric">{t('forecast.medianTime')}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.stages.map((row) => (
                <tr key={row.stageId}>
                  <td>{stages.get(row.stageId) ?? row.stageId.slice(0, 8)}</td>
                  <td className="numeric">{row.entered}</td>
                  <td className="numeric">{row.current}</td>
                  <td className="numeric">{row.exits.moved}</td>
                  <td className="numeric">{row.exits.won}</td>
                  <td className="numeric">{row.exits.lost}</td>
                  <td className="numeric">
                    {row.timeInStage.count ? duration(row.timeInStage.averageSeconds) : '—'}
                  </td>
                  <td className="numeric">
                    {row.timeInStage.count ? duration(row.timeInStage.medianSeconds) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="crm-columns">
        <div>
          <h3>{t('forecast.conversions')}</h3>
          {metrics.conversions.length === 0 ? (
            <Empty copy={t('forecast.noConversions')} />
          ) : (
            <ul className="crm-quote-list">
              {metrics.conversions.map((row) => (
                <li key={`${row.fromStageId}-${row.toStageId}`}>
                  {stages.get(row.fromStageId)} → {stages.get(row.toStageId)} · {row.count}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3>{t('forecast.lossReasons')}</h3>
          {metrics.lossReasons.length === 0 ? (
            <Empty copy={t('forecast.noLosses')} />
          ) : (
            <ul className="crm-quote-list">
              {metrics.lossReasons.map((row) => (
                <li key={row.lossReasonId}>
                  {reasons.get(row.lossReasonId) ?? row.lossReasonId.slice(0, 8)} · {row.count}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
