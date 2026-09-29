'use client'

import { MagnifyingGlass } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiError } from '@/lib/api'
import type { AttachmentRecord } from '@/lib/attachments'
import {
  DOCUMENT_SEARCH_MAX,
  DOCUMENT_SEARCH_MIN,
  type DocumentCitation,
  documentSearchPath,
} from '@/lib/documents'
import { tracedFetch } from '@/lib/telemetry'

/**
 * Search inside one record's attachments (Phase 75): each result names its file, where in
 * it the excerpt is, and the excerpt. The index knows no file names; the panel does.
 */
export function AttachmentSearch({
  record,
  names,
}: {
  record: AttachmentRecord
  names: ReadonlyMap<string, string>
}) {
  const t = useTranslations('attachments.search')
  const inputId = useId()
  const [text, setText] = useState('')
  const [results, setResults] = useState<DocumentCitation[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function search(event: FormEvent) {
    event.preventDefault()
    if (text.trim().length < DOCUMENT_SEARCH_MIN) return
    setBusy(true)
    setError('')
    try {
      const response = await tracedFetch('knowledge.search', documentSearchPath(text, { record }))
      if (!response.ok) throw new Error(await apiError(response, t('failed')))
      setResults(((await response.json()) as { data: DocumentCitation[] }).data)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form aria-busy={busy} className="attachments-search" onSubmit={(event) => void search(event)}>
      <label className="sr-only" htmlFor={inputId}>
        {t('label')}
      </label>
      <input
        className="ui-input"
        id={inputId}
        maxLength={DOCUMENT_SEARCH_MAX}
        onChange={(event) => setText(event.target.value)}
        placeholder={t('placeholder')}
        type="search"
        value={text}
      />
      <Button disabled={busy || text.trim().length < DOCUMENT_SEARCH_MIN} type="submit">
        <MagnifyingGlass aria-hidden="true" /> {t('submit')}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {results === null ? null : results.length === 0 ? (
        <p className="muted" role="status">
          {t('empty')}
        </p>
      ) : (
        <ol aria-label={t('results')} className="attachments-search-results">
          {results.map((citation) => (
            <li key={`${citation.attachmentId}:${citation.position.chunk}`}>
              <strong>{names.get(citation.attachmentId) ?? t('unnamed')}</strong>
              <small>
                {t('position', { chunk: citation.position.chunk, of: citation.position.of })}
              </small>
              <blockquote>{citation.excerpt}</blockquote>
            </li>
          ))}
        </ol>
      )}
    </form>
  )
}
