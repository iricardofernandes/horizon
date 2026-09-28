'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiError } from '@/lib/api'
import { jsonHeaders } from '@/lib/http'
import { isCurrent, type SavedView } from '@/lib/saved-views'
import { tracedFetch } from '@/lib/telemetry'

const BASE = '/api/horizon/reporting/views'

type Props = {
  screen: string
  query: string
  columns: string[] | null
  onApply: (view: SavedView) => void
}

/**
 * A list's saved views (Phase 66): pick one to apply it, keep what the screen shows under a
 * name, privately or for the whole workspace, and delete one's own.
 */
export function SavedViewsMenu({ screen, query, columns, onApply }: Props) {
  const t = useTranslations('views')
  const id = useId()
  const [views, setViews] = useState<SavedView[]>([])
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const response = await tracedFetch('views.list', `${BASE}?screen=${encodeURIComponent(screen)}`)
    if (response.ok) setViews(((await response.json()) as { data: SavedView[] }).data)
  }, [screen])

  useEffect(() => {
    void load()
  }, [load])

  const current = views.find((view) => isCurrent(view, query, columns))

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const response = await tracedFetch('views.create', BASE, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ screen, name, query, columns, shared }),
    })
    if (!response.ok) {
      setError(await apiError(response, t('failed')))
      return
    }
    setSaving(false)
    setName('')
    setShared(false)
    await load()
  }

  async function remove(view: SavedView) {
    const response = await tracedFetch('views.remove', `${BASE}/${view.id}`, { method: 'DELETE' })
    if (!response.ok) setError(await apiError(response, t('failed')))
    await load()
  }

  return (
    <div className="saved-views">
      <label className="saved-views-pick" htmlFor={`${id}-pick`}>
        <span>{t('label')}</span>
        <select
          className="ui-input"
          id={`${id}-pick`}
          onChange={(event) => {
            const view = views.find((candidate) => candidate.id === event.target.value)
            if (view) onApply(view)
          }}
          value={current?.id ?? ''}
        >
          <option value="">{t('none')}</option>
          {views.map((view) => (
            <option key={view.id} value={view.id}>
              {view.shared ? t('sharedName', { name: view.name }) : view.name}
            </option>
          ))}
        </select>
      </label>
      {current?.mine ? (
        <Button onClick={() => void remove(current)} type="button" variant="ghost">
          {t('remove')}
        </Button>
      ) : null}
      {saving ? (
        <form className="saved-views-form" onSubmit={(event) => void save(event)}>
          <input
            aria-label={t('name')}
            className="ui-input"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('namePlaceholder')}
            required
            value={name}
          />
          <label>
            <input
              checked={shared}
              onChange={(event) => setShared(event.target.checked)}
              type="checkbox"
            />{' '}
            {t('share')}
          </label>
          <Button type="submit" variant="secondary">
            {t('save')}
          </Button>
          <Button onClick={() => setSaving(false)} type="button" variant="ghost">
            {t('cancel')}
          </Button>
        </form>
      ) : (
        <Button onClick={() => setSaving(true)} type="button" variant="ghost">
          {t('saveCurrent')}
        </Button>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}

/** Which optional columns a list shows. */
export function ColumnPicker({
  all,
  shown,
  label,
  labelOf,
  onChange,
}: {
  all: readonly string[]
  shown: readonly string[]
  label: string
  labelOf: (column: string) => string
  onChange: (columns: string[] | null) => void
}) {
  return (
    <fieldset className="column-picker">
      <legend>{label}</legend>
      {all.map((column) => (
        <label key={column}>
          <input
            checked={shown.includes(column)}
            onChange={(event) => {
              const next = event.target.checked
                ? all.filter((candidate) => candidate === column || shown.includes(candidate))
                : shown.filter((candidate) => candidate !== column)
              onChange(next.length === all.length ? null : next)
            }}
            type="checkbox"
          />{' '}
          {labelOf(column)}
        </label>
      ))}
    </fieldset>
  )
}
