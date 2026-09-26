'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Tabs } from '@base-ui/react/tabs'
import { DownloadSimple, X } from '@phosphor-icons/react'
import { useFormatter, useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Empty, LoadingState, Notice } from '@/components/ui/state'
import { short } from '@/lib/format'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime } from '@/lib/use-format'
import { DocumentActions } from './document-actions'
import { SimulationLabel } from './simulation-label'
import {
  type Artifact,
  type CalculationExplanation,
  type DocumentSummary,
  documentUrl,
  FISCAL_API,
  isUncertain,
  statusTone,
  type Transition,
} from './types'

type Links = {
  kind: string
  references: (
    | { type: 'document'; documentId: string }
    | { type: 'supplier-invoice'; importId: string }
  )[]
  linked: {
    linkedOriginId: string
    kind: string
    documentId: string | null
    status: string | null
  }[]
  correlations: { module: string; sourceEvent: string; correlationId: string }[]
}

type Detail = {
  document: Record<string, unknown> & { status: DocumentSummary['status'] }
  transitions: Transition[]
  explanation: CalculationExplanation | null
  artifacts: Artifact[]
  links: Links | null
}

async function optional<T>(name: string, url: string): Promise<T | null> {
  const response = await tracedFetch(name, url, { cache: 'no-store' })
  if (!response.ok) return null
  return (await response.json()) as T
}

async function loadDetail(summary: DocumentSummary): Promise<Detail | null> {
  const base = `${FISCAL_API}/documents/${summary.id}`
  const [document, timeline, explanation, artifacts, links] = await Promise.all([
    optional<Detail['document']>('fiscal.document.read', documentUrl(summary)),
    optional<{ transitions: Transition[] }>('fiscal.document.timeline', `${base}/transitions`),
    optional<CalculationExplanation>(
      'fiscal.document.explanation',
      `${base}/calculation/explanation`,
    ),
    optional<{ artifacts: Artifact[] }>('fiscal.document.artifacts', `${base}/artifacts`),
    summary.model === 'nfse'
      ? Promise.resolve(null)
      : optional<Links>('fiscal.document.links', `${base}/links`),
  ])
  if (!document) return null
  return {
    document,
    transitions: timeline?.transitions ?? [],
    explanation,
    artifacts: artifacts?.artifacts ?? [],
    links,
  }
}

/** One document of any model: what it is, how it got here, why it costs what it costs. */
export function DocumentDialog({
  summary,
  onClose,
  onChanged,
}: {
  summary: DocumentSummary
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('fiscal')
  const common = useTranslations('common')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setDetail(await loadDetail(summary).catch(() => null))
    setLoading(false)
  }, [summary])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const status = detail?.document.status ?? summary.status
  const title = t('dialog.title', {
    model: t(`models.${summary.model}`),
    number: summary.number ?? '—',
  })

  return (
    <Dialog.Root onOpenChange={(open) => !open && onClose()} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup order-detail-dialog fiscal-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('dialog.description', { id: short(summary.id) })}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <div className="fiscal-dialog-banner">
            <SimulationLabel simulated={summary.simulated} />
            <Badge label={t(`status.${status}`)} status={statusTone(status)} />
          </div>
          {isUncertain(status) ? <Notice copy={t('dialog.uncertain')} /> : null}
          {summary.lastRejectionCode ? (
            <p className="form-error" role="alert">
              {t('dialog.rejected', { code: summary.lastRejectionCode })}
            </p>
          ) : null}
          {loading ? (
            <LoadingState />
          ) : !detail ? (
            <Notice copy={t('dialog.unavailable')} />
          ) : (
            <DetailTabs detail={detail} summary={summary} />
          )}
          <DocumentActions
            onChanged={async () => {
              await refresh()
              await onChanged()
            }}
            status={status}
            summary={summary}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function DetailTabs({ detail, summary }: { detail: Detail; summary: DocumentSummary }) {
  const t = useTranslations('fiscal')
  const dateTime = useDateTime()
  const format = useFormatter()
  return (
    <Tabs.Root defaultValue="timeline">
      <Tabs.List aria-label={t('dialog.sections')} className="ui-tabs-list">
        <Tabs.Tab className="ui-tab" value="timeline">
          {t('dialog.timeline')}
        </Tabs.Tab>
        <Tabs.Tab className="ui-tab" value="explanation">
          {t('dialog.explanation')}
        </Tabs.Tab>
        <Tabs.Tab className="ui-tab" value="artifacts">
          {t('dialog.artifacts')}
        </Tabs.Tab>
        {detail.links ? (
          <Tabs.Tab className="ui-tab" value="links">
            {t('dialog.links')}
          </Tabs.Tab>
        ) : null}
      </Tabs.List>
      <Tabs.Panel className="fiscal-tab" value="timeline">
        <ol className="fiscal-timeline">
          {detail.transitions.map((transition) => (
            <li key={transition.id}>
              <Badge label={t(`status.${transition.to}`)} status={statusTone(transition.to)} />
              <span>{dateTime(transition.occurredAt)}</span>
              <small>{transition.actorId}</small>
            </li>
          ))}
        </ol>
        {!detail.transitions.length ? <Empty copy={t('dialog.noTransitions')} /> : null}
      </Tabs.Panel>
      <Tabs.Panel className="fiscal-tab" value="explanation">
        {detail.explanation ? (
          <Explanation explanation={detail.explanation} />
        ) : (
          <Empty copy={t('dialog.noExplanation')} />
        )}
      </Tabs.Panel>
      <Tabs.Panel className="fiscal-tab" value="artifacts">
        <ul className="fiscal-artifacts">
          {detail.artifacts.map((artifact) => (
            <li key={`${artifact.kind}-${artifact.digest}`}>
              <span>
                <strong>
                  {t.has(`artifacts.${artifact.kind}`)
                    ? t(`artifacts.${artifact.kind}`)
                    : artifact.kind}
                </strong>
                <small>
                  {format.number(artifact.byteSize)} B · SHA-256 {artifact.digest.slice(0, 12)}…
                </small>
              </span>
              <a
                className="ui-button ui-button-ghost"
                download
                href={`${FISCAL_API}/documents/${summary.id}/artifacts/${artifact.kind}?digest=${artifact.digest}`}
              >
                <DownloadSimple aria-hidden="true" size={15} /> {t('dialog.download')}
              </a>
            </li>
          ))}
        </ul>
        {!detail.artifacts.length ? <Empty copy={t('dialog.noArtifacts')} /> : null}
      </Tabs.Panel>
      {detail.links ? (
        <Tabs.Panel className="fiscal-tab" value="links">
          <LinksPanel links={detail.links} />
        </Tabs.Panel>
      ) : null}
    </Tabs.Root>
  )
}

function Explanation({ explanation }: { explanation: CalculationExplanation }) {
  const t = useTranslations('fiscal')
  const text =
    explanation.explanation &&
    typeof explanation.explanation === 'object' &&
    'text' in explanation.explanation
      ? String((explanation.explanation as { text: unknown }).text)
      : JSON.stringify(explanation.explanation, null, 2)
  return (
    <div className="fiscal-explanation">
      <pre>{text}</pre>
      <h3>{t('dialog.sources')}</h3>
      <ul>
        {explanation.sources.map((source) => (
          <li key={source.digest}>
            <code className="table-code">{source.digest.slice(0, 12)}…</code>{' '}
            {String(source.uri ?? source.sourceUri ?? '')}{' '}
            {source.section ? <small>§ {String(source.section)}</small> : null}
          </li>
        ))}
      </ul>
      <p className="dialog-description">
        {t('dialog.digests', {
          input: explanation.inputDigest.slice(0, 12),
          result: explanation.resultDigest.slice(0, 12),
        })}
      </p>
    </div>
  )
}

function LinksPanel({ links }: { links: Links }) {
  const t = useTranslations('fiscal')
  return (
    <div className="fiscal-links">
      <p>{t('links.kind', { kind: links.kind })}</p>
      <h3>{t('links.references')}</h3>
      {links.references.length ? (
        <ul>
          {links.references.map((reference) => (
            <li key={reference.type === 'document' ? reference.documentId : reference.importId}>
              {reference.type === 'document'
                ? t('links.document', { id: short(reference.documentId) })
                : t('links.supplierInvoice', { id: short(reference.importId) })}
            </li>
          ))}
        </ul>
      ) : (
        <Empty copy={t('links.noReferences')} />
      )}
      <h3>{t('links.linked')}</h3>
      {links.linked.length ? (
        <ul>
          {links.linked.map((linked) => (
            <li key={linked.linkedOriginId}>
              {t('links.linkedDocument', {
                kind: linked.kind,
                id: linked.documentId ? short(linked.documentId) : '—',
                status: linked.status ?? '—',
              })}
            </li>
          ))}
        </ul>
      ) : (
        <Empty copy={t('links.noLinked')} />
      )}
      <h3>{t('links.owners')}</h3>
      <ul>
        {links.correlations.map((correlation) => (
          <li key={`${correlation.module}-${correlation.correlationId}`}>
            {t('links.owner', { module: correlation.module, event: correlation.sourceEvent })}
          </li>
        ))}
      </ul>
      {!links.correlations.length ? <Empty copy={t('links.noOwners')} /> : null}
    </div>
  )
}
