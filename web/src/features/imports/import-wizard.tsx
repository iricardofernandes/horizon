'use client'

import { useLocale, useTranslations } from 'next-intl'
import { type FormEvent, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PanelHeading } from '@/components/ui/headings'
import { SelectField } from '@/components/ui/select-field'
import {
  addsUp,
  type ImportJob,
  type ImportKind,
  type ImportPreview,
  isFinished,
  jobKeyOf,
  percentDone,
  uploadBody,
} from '@/lib/import-file'
import type { ImportApi } from './import-api'

const POLL_MS = 1500
const UNMAPPED = '__none__'

type Props = {
  api: ImportApi
  kinds: ImportKind[]
  job: ImportJob | null
  onJob: (job: ImportJob | null) => void
}

/** The counts of a job, which always add up to the file's rows. */
export function ProgressCounts({ job }: { job: ImportJob }) {
  const t = useTranslations('imports')
  const { progress } = job
  return (
    <div className="import-progress" aria-live="polite">
      <progress max={100} value={percentDone(progress)} />
      <p>
        {t('counts', {
          total: progress.total,
          written: progress.written,
          failed: progress.failed,
          remaining: progress.remaining,
          cancelled: progress.cancelled,
        })}
      </p>
      {addsUp(progress) ? null : <p role="alert">{t('countsMismatch')}</p>}
    </div>
  )
}

function FieldLabel({ name }: { name: string }) {
  const t = useTranslations('imports.fields')
  return <>{t.has(name) ? t(name) : name}</>
}

/**
 * Upload, map, preview, confirm and follow one import (ADR 0059). The module validates
 * every row; the screen only shows what it said.
 */
export function ImportWizard({ api, kinds, job, onJob }: Props) {
  const t = useTranslations('imports')
  const locale = useLocale() === 'en' ? 'en' : 'pt-BR'
  const [kind, setKind] = useState(kinds[0]?.kind ?? '')
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fields = kinds.find((candidate) => candidate.kind === (job?.kind ?? kind))?.fields ?? []

  useEffect(() => {
    setMapping(job?.mapping ?? {})
    if (job?.status !== 'previewed') setPreview(null)
  }, [job?.mapping, job?.status])

  useEffect(() => {
    if (!job || isFinished(job.status) || job.status !== 'running') return
    const timer = setInterval(() => {
      void api.get(job.id).then(onJob, () => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [api, job, onJob])

  async function run(step: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await step()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }

  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const file = new FormData(event.currentTarget).get('file')
    void run(async () => {
      if (!(file instanceof File)) throw new Error(t('fileInvalid'))
      const bytes = new Uint8Array(await file.arrayBuffer())
      const body = uploadBody(file.name, bytes, locale)
      if (!body) throw new Error(t('fileInvalid'))
      onJob(await api.upload(kind, await jobKeyOf(kind, bytes), body))
    })
  }

  const current = job
  return (
    <section className="panel form-panel import-wizard">
      <PanelHeading title={t('wizard.title')} copy={t('wizard.copy')} />
      {!current ? (
        <form onSubmit={upload}>
          <SelectField
            label={t('kind')}
            name="kind"
            onValueChange={(value) => setKind(value ?? '')}
            options={kinds.map((option) => ({
              label: t(`kinds.${option.kind}`),
              value: option.kind,
            }))}
            value={kind}
          />
          <label className="ui-field">
            <span className="ui-field-label">{t('file')}</span>
            <input accept=".csv,.xlsx" className="ui-input" name="file" required type="file" />
          </label>
          <Button disabled={busy || !kind} type="submit" variant="primary">
            {busy ? t('uploading') : t('upload')}
          </Button>
        </form>
      ) : (
        <>
          <p>
            <strong>{current.fileName}</strong> · {t(`kinds.${current.kind}`)} ·{' '}
            <Badge label={t(`status.${current.status}`)} status={current.status} />
          </p>
          <ProgressCounts job={current} />
          {['uploaded', 'validated', 'previewed'].includes(current.status) ? (
            <MappingForm
              busy={busy}
              columns={current.columns}
              fields={fields}
              mapping={mapping}
              onChange={setMapping}
              onValidate={() =>
                void run(async () => {
                  const mapped = await api.map(current.id, mapping)
                  const shown = await api.preview(mapped.id)
                  setPreview(shown)
                  onJob(shown.job)
                })
              }
            />
          ) : null}
          {preview && current.status === 'previewed' ? <PreviewTable preview={preview} /> : null}
          <JobActions api={api} busy={busy} job={current} onJob={onJob} run={run} />
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  )
}

type ActionsProps = {
  api: ImportApi
  busy: boolean
  job: ImportJob
  onJob: (job: ImportJob | null) => void
  run: (step: () => Promise<void>) => Promise<void>
}

/** Confirm once previewed, cancel until it ends, and download what failed. */
function JobActions({ api, busy, job, onJob, run }: ActionsProps) {
  const t = useTranslations('imports')
  const current = job
  return (
    <div className="page-actions">
      {current.status === 'previewed' ? (
        <Button
          disabled={busy || current.progress.valid === 0}
          onClick={() => void run(async () => onJob(await api.confirm(current.id)))}
          variant="primary"
        >
          {t('confirm', { count: current.progress.valid })}
        </Button>
      ) : null}
      {!isFinished(current.status) ? (
        <Button
          disabled={busy}
          onClick={() => void run(async () => onJob(await api.cancel(current.id)))}
          variant="danger"
        >
          {t('cancel')}
        </Button>
      ) : null}
      {current.progress.failed > 0 ? (
        <a className="ui-button ui-button-secondary" download href={api.failuresUrl(current.id)}>
          {t('downloadFailures')}
        </a>
      ) : null}
      <Button onClick={() => onJob(null)} variant="ghost">
        {t('another')}
      </Button>
    </div>
  )
}

type MappingProps = {
  busy: boolean
  columns: string[]
  fields: ImportKind['fields']
  mapping: Record<string, string | null>
  onChange: (
    update: (previous: Record<string, string | null>) => Record<string, string | null>,
  ) => void
  onValidate: () => void
}

/** Which column of the file feeds each field; a required field is marked. */
function MappingForm({ busy, columns, fields, mapping, onChange, onValidate }: MappingProps) {
  const t = useTranslations('imports')
  const options = [
    { label: t('mapping.none'), value: UNMAPPED },
    ...columns.map((column) => ({ label: column, value: column })),
  ]
  return (
    <div className="import-mapping">
      <h3>{t('mapping.title')}</h3>
      {fields.map((field) => (
        <SelectField
          key={field.name}
          label={
            <>
              <FieldLabel name={field.name} />
              {field.required ? ' *' : ''}
            </>
          }
          name={field.name}
          onValueChange={(value) =>
            onChange((previous) => ({
              ...previous,
              [field.name]: value === UNMAPPED ? null : value,
            }))
          }
          options={options}
          value={mapping[field.name] ?? UNMAPPED}
        />
      ))}
      <Button disabled={busy} onClick={onValidate} variant="secondary">
        {t('mapping.validate')}
      </Button>
    </div>
  )
}

function PreviewTable({ preview }: { preview: ImportPreview }) {
  const t = useTranslations('imports')
  const fields = Object.keys(preview.sample[0]?.values ?? {})
  return (
    <div className="import-preview">
      <h3>{t('preview.errors')}</h3>
      {preview.errors.length === 0 ? (
        <p>{t('preview.noErrors')}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('preview.line')}</th>
                <th>{t('preview.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {preview.errors.map((row) => (
                <tr key={row.line}>
                  <td>{row.line}</td>
                  <td>
                    {row.reasons
                      .map((reason) =>
                        reason.field ? `${reason.field}: ${reason.message}` : reason.message,
                      )
                      .join('; ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>{t('preview.sample')}</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('preview.line')}</th>
              {fields.map((field) => (
                <th key={field}>
                  <FieldLabel name={field} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.sample.map((row) => (
              <tr key={row.line}>
                <td>{row.line}</td>
                {fields.map((field) => (
                  <td key={field}>{row.values[field] ?? '—'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
