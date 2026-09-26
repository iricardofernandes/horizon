'use client'

import { Eye } from '@phosphor-icons/react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { SelectField } from '@/components/ui/select-field'
import { Empty, LoadingState, Notice } from '@/components/ui/state'
import { readJson, SessionExpiredError } from '@/lib/api'
import { useDateTime } from '@/lib/use-format'
import { DocumentDialog } from './document-dialog'
import { SimulationLabel } from './simulation-label'
import {
  DOCUMENT_MODELS,
  DOCUMENT_STATUSES,
  type DocumentPage,
  type DocumentSummary,
  FISCAL_API,
  statusTone,
} from './types'

const ALL = 'all'
const PAGE_SIZE = 25

/**
 * The operator worklist: every document of every model, newest first. A row opens the
 * document; nothing on this screen changes a document by itself.
 */
export function DocumentsView() {
  const t = useTranslations('fiscal')
  const router = useRouter()
  const dateTime = useDateTime()
  const [status, setStatus] = useState(ALL)
  const [model, setModel] = useState(ALL)
  const [rows, setRows] = useState<DocumentSummary[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<DocumentSummary | null>(null)

  const load = useCallback(
    async (after?: string) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (status !== ALL) query.set('status', status)
      if (model !== ALL) query.set('model', model)
      if (after) query.set('cursor', after)
      try {
        const page = await readJson<DocumentPage>(
          'fiscal.documents.list',
          `${FISCAL_API}/documents?${query}`,
        )
        setRows((current) => (after ? [...current, ...page.data] : page.data))
        setCursor(page.page.hasMore ? page.page.nextCursor : undefined)
        setFailed(false)
      } catch (cause) {
        if (cause instanceof SessionExpiredError) router.replace('/login')
        else setFailed(true)
      } finally {
        setLoading(false)
      }
    },
    [model, router, status],
  )

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const statusOptions = [
    { value: ALL, label: t('filters.allStatuses') },
    ...DOCUMENT_STATUSES.map((value) => ({ value, label: t(`status.${value}`) })),
  ]
  const modelOptions = [
    { value: ALL, label: t('filters.allModels') },
    ...DOCUMENT_MODELS.map((value) => ({ value, label: t(`models.${value}`) })),
  ]

  return (
    <section className="fiscal-page">
      <PageHeading eyebrow={t('eyebrow')} title={t('documents.title')} copy={t('documents.copy')} />
      <section className="panel">
        <PanelHeading title={t('documents.panelTitle')} copy={t('documents.panelCopy')} />
        <div className="fiscal-filters">
          <SelectField
            label={t('filters.status')}
            name="status"
            onValueChange={(value) => setStatus(value ?? ALL)}
            options={statusOptions}
            value={status}
          />
          <SelectField
            label={t('filters.model')}
            name="model"
            onValueChange={(value) => setModel(value ?? ALL)}
            options={modelOptions}
            value={model}
          />
        </div>
        {loading ? (
          <LoadingState />
        ) : failed ? (
          <Notice copy={t('documents.unavailable')} />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('documents.model')}</th>
                  <th>{t('documents.number')}</th>
                  <th>{t('documents.status')}</th>
                  <th>{t('documents.pending')}</th>
                  <th>{t('documents.updated')}</th>
                  <th>{t('documents.environment')}</th>
                  <th aria-label={t('documents.open')} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{t(`models.${row.model}`)}</td>
                    <td>
                      {row.number === null
                        ? t('documents.noNumber')
                        : t('documents.seriesNumber', { series: row.series, number: row.number })}
                    </td>
                    <td>
                      <Badge label={t(`status.${row.status}`)} status={statusTone(row.status)} />
                      {row.lastRejectionCode ? (
                        <code className="table-code fiscal-code">{row.lastRejectionCode}</code>
                      ) : null}
                    </td>
                    <td>
                      {row.pending
                        ? t('documents.pendingCommand', {
                            kind: t(`commands.${row.pending.kind}`),
                            attempts: row.pending.attemptCount,
                          })
                        : t('documents.nothingPending')}
                    </td>
                    <td>{dateTime(row.updatedAt)}</td>
                    <td>
                      <SimulationLabel compact simulated={row.simulated} />
                    </td>
                    <td>
                      <Button
                        aria-label={t('documents.openDocument', {
                          model: t(`models.${row.model}`),
                          number: row.number ?? '—',
                        })}
                        onClick={() => setOpen(row)}
                        type="button"
                      >
                        <Eye aria-hidden="true" size={15} /> {t('documents.open')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length ? <Empty copy={t('documents.empty')} /> : null}
            {cursor ? (
              <div className="fiscal-more">
                <Button onClick={() => void load(cursor)} type="button" variant="secondary">
                  {t('documents.more')}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
      {open ? (
        <DocumentDialog onChanged={() => load()} onClose={() => setOpen(null)} summary={open} />
      ) : null}
    </section>
  )
}
