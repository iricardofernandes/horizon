'use client'

import { Paperclip } from '@phosphor-icons/react'
import { useFormatter, useTranslations } from 'next-intl'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { apiError } from '@/lib/api'
import {
  ACCEPTED_EXTENSIONS,
  type Attachment,
  type AttachmentLink,
  type AttachmentRecord,
  attachmentAbilities,
  isSettling,
  proxied,
  refusalOf,
  sizeLabel,
  slotRequestOf,
} from '@/lib/attachments'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'

const BASE = '/api/horizon/files/attachments'
const POLL_MS = 2000

/** Asks for a slot, then sends the bytes to the signed link it answered (Phase 65). */
async function uploadFile(record: AttachmentRecord, file: File, failed: string): Promise<void> {
  const body = slotRequestOf(record, file)
  const slot = await tracedFetch('files.attachment.request', BASE, {
    method: 'POST',
    headers: { ...jsonHeaders(), 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(body),
  })
  if (!slot.ok) throw new Error(await apiError(slot, failed))
  const { upload } = (await slot.json()) as { upload: AttachmentLink | null }
  if (!upload) return
  const sent = await tracedFetch('files.attachment.upload', proxied(upload), {
    method: 'PUT',
    headers: { 'content-type': body.contentType ?? 'application/octet-stream' },
    body: file,
  })
  if (!sent.ok) throw new Error(await apiError(sent, failed))
}

/**
 * The files attached to one record: listed for whoever reads it, attached and removed by
 * whoever writes it, in the owning module's role. A file is offered for download only once
 * its scan found it clean.
 */
export function AttachmentsPanel({ record }: { record: AttachmentRecord }) {
  const t = useTranslations('attachments')
  const format = useFormatter()
  const session = useSession()
  const abilities = useMemo(
    () => attachmentAbilities(session?.roles ?? [], record.module),
    [session?.roles, record.module],
  )
  const [rows, setRows] = useState<Attachment[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const query = new URLSearchParams({
    module: record.module,
    recordType: record.recordType,
    recordId: record.recordId,
  }).toString()

  const load = useCallback(async () => {
    const response = await tracedFetch('files.attachment.list', `${BASE}?${query}`, {
      cache: 'no-store',
    })
    if (!response.ok) {
      setError(await apiError(response, t('failed')))
      return
    }
    setRows(((await response.json()) as { data: Attachment[] }).data)
  }, [query, t])

  useEffect(() => {
    if (abilities.canRead) void load()
  }, [abilities.canRead, load])

  useEffect(() => {
    if (!rows || !isSettling(rows)) return
    const timer = setTimeout(() => void load(), POLL_MS)
    return () => clearTimeout(timer)
  }, [rows, load])

  if (!abilities.canRead) return null

  async function run(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await work()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }

  async function attach(file: File | undefined) {
    if (!file) return
    const refusal = refusalOf(file)
    if (refusal) {
      setError(t(`refused.${refusal}`))
      return
    }
    await run(() => uploadFile(record, file, t('failed')))
    if (input.current) input.current.value = ''
  }

  async function download(attachment: Attachment) {
    await run(async () => {
      const response = await tracedFetch('files.attachment.link', `${BASE}/${attachment.id}/link`)
      if (!response.ok) throw new Error(await apiError(response, t('failed')))
      window.location.assign(proxied((await response.json()) as AttachmentLink))
    })
  }

  async function remove(attachment: Attachment) {
    if (!window.confirm(t('confirmRemove', { name: attachment.fileName }))) return
    await run(async () => {
      const response = await tracedFetch('files.attachment.remove', `${BASE}/${attachment.id}`, {
        method: 'DELETE',
      })
      if (!response.ok) throw new Error(await apiError(response, t('failed')))
    })
  }

  return (
    <section className="receivable-section attachments-panel" aria-busy={busy}>
      <div className="attachments-heading">
        <h3>{t('title')}</h3>
        {abilities.canWrite ? (
          <>
            <input
              accept={ACCEPTED_EXTENSIONS}
              aria-label={t('choose')}
              className="sr-only"
              disabled={busy}
              onChange={(event) => void attach(event.target.files?.[0])}
              ref={input}
              type="file"
            />
            <Button disabled={busy} onClick={() => input.current?.click()} type="button">
              <Paperclip aria-hidden="true" /> {t('attach')}
            </Button>
          </>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {rows === null ? null : rows.length === 0 ? (
        <p className="muted">{t('empty')}</p>
      ) : (
        <ul className="attachments-list">
          {rows.map((attachment) => (
            <li key={attachment.id}>
              {attachment.status === 'available' ? (
                <button
                  className="crm-link-button"
                  disabled={busy}
                  onClick={() => void download(attachment)}
                  type="button"
                >
                  {attachment.fileName}
                </button>
              ) : (
                <span>{attachment.fileName}</span>
              )}
              <small>
                {t('meta', {
                  size: sizeLabel(attachment.size, (value, digits) =>
                    format.number(value, { maximumFractionDigits: digits }),
                  ),
                  date: format.dateTime(new Date(attachment.createdAt), { dateStyle: 'short' }),
                })}
              </small>
              <Badge label={t(`status.${attachment.status}`)} status={attachment.status} />
              {attachment.status === 'quarantined' ? (
                <small role="note">{t('quarantinedNote')}</small>
              ) : null}
              {abilities.canWrite ? (
                <Button
                  disabled={busy}
                  onClick={() => void remove(attachment)}
                  type="button"
                  variant="ghost"
                >
                  {t('remove')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="muted">{t('hint')}</p>
    </section>
  )
}
