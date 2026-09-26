'use client'

import { Eye, UploadSimple } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { Empty, Notice } from '@/components/ui/state'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime } from '@/lib/use-format'
import { useFiscalRole } from './client'
import { ImportDialog } from './import-dialog'
import { FISCAL_API, type ImportSummary } from './types'

/** The API refuses larger bodies; the form says so before sending. */
const XML_LIMIT_BYTES = 1024 * 1024

const IMPORT_TONE: Record<ImportSummary['status'], string> = {
  open: 'pending',
  blocked: 'rejected',
  reconciled: 'approved',
}

/**
 * Supplier NF-e XML is evidence: importing it verifies the signed bytes and proposes the
 * receipts it matches. Stock and payables stay with Procurement and Financial (ADR 0051).
 */
export function InboundView({
  imports,
  onChanged,
}: {
  imports: ImportSummary[]
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('fiscal')
  const dateTime = useDateTime()
  const role = useFiscalRole()
  const canReview = role === 'admin' || role === 'reviewer'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setNotice('')
    const form = event.currentTarget
    const file = new FormData(form).get('xml')
    if (!(file instanceof File) || !file.size || file.size > XML_LIMIT_BYTES) {
      setError(t('inbound.fileInvalid'))
      return
    }
    setBusy(true)
    const response = await tracedFetch('fiscal.imports.upload', `${FISCAL_API}/imports`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: await file.arrayBuffer(),
    })
    const body = (await response.json().catch(() => ({}))) as {
      importId?: string
      outcome?: string
      code?: string
      detail?: string
    }
    setBusy(false)
    if (!response.ok) {
      setError(
        t('actions.refused', {
          code: body.code ?? String(response.status),
          detail: body.detail ?? t('actions.noDetail'),
        }),
      )
      return
    }
    form.reset()
    setNotice(body.outcome === 'duplicate' ? t('inbound.duplicate') : t('inbound.imported'))
    await onChanged()
    if (body.importId) setOpen(body.importId)
  }

  return (
    <section className="fiscal-page">
      <PageHeading eyebrow={t('eyebrow')} title={t('inbound.title')} copy={t('inbound.copy')} />
      {canReview ? (
        <section className="panel form-panel fiscal-upload">
          <PanelHeading title={t('inbound.uploadTitle')} copy={t('inbound.uploadCopy')} />
          <form onSubmit={upload}>
            <label className="ui-field">
              <span className="ui-field-label">{t('inbound.file')}</span>
              <input
                accept=".xml,application/xml,text/xml"
                className="ui-input"
                name="xml"
                required
                type="file"
              />
            </label>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            {notice ? <p role="status">{notice}</p> : null}
            <Button disabled={busy} type="submit" variant="primary">
              <UploadSimple aria-hidden="true" size={15} />{' '}
              {busy ? t('inbound.uploading') : t('inbound.upload')}
            </Button>
          </form>
        </section>
      ) : (
        <Notice copy={t('inbound.readOnly')} />
      )}
      <section className="panel">
        <PanelHeading title={t('inbound.listTitle')} copy={t('inbound.listCopy')} />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('inbound.number')}</th>
                <th>{t('inbound.issuedAt')}</th>
                <th>{t('inbound.total')}</th>
                <th>{t('inbound.lines')}</th>
                <th>{t('inbound.status')}</th>
                <th>{t('inbound.importedAt')}</th>
                <th aria-label={t('documents.open')} />
              </tr>
            </thead>
            <tbody>
              {imports.map((row) => (
                <tr key={row.id}>
                  <td>{t('documents.seriesNumber', { series: row.series, number: row.number })}</td>
                  <td>{row.issuedAt.slice(0, 10)}</td>
                  <td>{row.invoiceTotal}</td>
                  <td>{row.lineCount}</td>
                  <td>
                    <Badge
                      label={t(`inbound.statuses.${row.status}`)}
                      status={IMPORT_TONE[row.status]}
                    />
                  </td>
                  <td>{dateTime(row.importedAt)}</td>
                  <td>
                    <Button
                      aria-label={t('inbound.openImport', { number: row.number })}
                      disabled={!canReview}
                      onClick={() => setOpen(row.id)}
                      type="button"
                    >
                      <Eye aria-hidden="true" size={15} /> {t('documents.open')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!imports.length ? <Empty copy={t('inbound.empty')} /> : null}
        </div>
      </section>
      {open ? (
        <ImportDialog importId={open} onChanged={onChanged} onClose={() => setOpen(null)} />
      ) : null}
    </section>
  )
}
