'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading, Stat } from '@/components/ui/headings'
import { Empty } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { tracedFetch } from '@/lib/telemetry'
import { useDate, useDateTime } from '@/lib/use-format'
import {
  ageParts,
  type DocumentKind,
  FISCAL_API,
  type MunicipalityResolution,
  type SupportOverview,
} from './types'

const CERTIFICATE_TONE = { valid: 'approved', expiring: 'pending', expired: 'rejected' } as const

export type SupportData = {
  overview: SupportOverview
  kinds: DocumentKind[]
}

/**
 * What an operator checks first: work waiting, outcomes not known yet, what the authority
 * refused, certificates about to expire, and exactly which tuples are supported.
 */
export function SupportView({ data }: { data: SupportData }) {
  const t = useTranslations('fiscal')
  const format = useFormatter()
  const dateTime = useDateTime()
  const date = useDate()
  const { overview } = data
  const age = (seconds: number) => {
    const parts = ageParts(seconds)
    return t(`support.age.${parts.unit}`, { value: parts.value })
  }
  return (
    <section className="fiscal-page">
      <PageHeading eyebrow={t('eyebrow')} title={t('support.title')} copy={t('support.copy')} />
      {overview.simulationOnly ? (
        <p className="fiscal-simulation-note">{t('support.simulationOnly')}</p>
      ) : null}
      <div className="stat-grid">
        <Stat
          label={t('support.queue')}
          note={t('support.queueNote', { age: age(overview.queue.oldestDueSeconds) })}
          value={format.number(overview.queue.pending + overview.queue.leased)}
        />
        <Stat
          label={t('support.unknown')}
          note={t('support.unknownNote')}
          value={format.number(overview.unknownOutcomes)}
        />
        <Stat
          label={t('support.outbox')}
          note={t('support.outboxNote', { age: age(overview.outbox.oldestUndeliveredSeconds) })}
          value={format.number(overview.outbox.undelivered)}
        />
        <Stat
          label={t('support.imports')}
          note={t('support.importsNote', { blocked: overview.imports.blocked })}
          value={format.number(overview.imports.open + overview.imports.blocked)}
        />
      </div>
      <div className="split-grid">
        <section className="panel">
          <PanelHeading title={t('support.rejectionsTitle')} copy={t('support.rejectionsCopy')} />
          {overview.rejections.length ? (
            <table>
              <thead>
                <tr>
                  <th>{t('support.code')}</th>
                  <th>{t('support.count')}</th>
                  <th>{t('support.lastSeen')}</th>
                </tr>
              </thead>
              <tbody>
                {overview.rejections.map((row) => (
                  <tr key={row.code}>
                    <td>
                      <code className="table-code">{row.code}</code>
                    </td>
                    <td>{row.count}</td>
                    <td>{dateTime(row.lastObservedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty copy={t('support.noRejections')} />
          )}
        </section>
        <section className="panel">
          <PanelHeading
            title={t('support.certificatesTitle')}
            copy={t('support.certificatesCopy')}
          />
          {overview.certificates.length ? (
            <ul className="fiscal-list">
              {overview.certificates.map((row) => (
                <li key={row.fingerprint}>
                  <Badge
                    label={t(`certificate.${row.state}`)}
                    status={CERTIFICATE_TONE[row.state]}
                  />
                  <span>
                    {t('support.certificate', {
                      establishment: row.establishmentId.slice(0, 8),
                      date: date(row.validUntil),
                      days: row.daysRemaining,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty copy={t('support.noCertificates')} />
          )}
        </section>
      </div>
      <section className="panel">
        <PanelHeading title={t('support.documentsTitle')} copy={t('support.documentsCopy')} />
        <ul className="fiscal-counts">
          {Object.entries(overview.documents).map(([status, count]) => (
            <li key={status}>
              <strong>{count}</strong> {t(`status.${status}`)}
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <PanelHeading title={t('support.matrixTitle')} copy={t('support.matrixCopy')} />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('support.model')}</th>
                <th>{t('support.environment')}</th>
                <th>{t('support.jurisdiction')}</th>
                <th>{t('support.operation')}</th>
                <th>{t('support.adapter')}</th>
                <th>{t('support.state')}</th>
                <th>{t('support.activated')}</th>
              </tr>
            </thead>
            <tbody>
              {overview.capabilities.map((row) => (
                <tr key={row.id}>
                  <td>{t(`models.${row.model}`)}</td>
                  <td>{t(`environments.${row.environment}`)}</td>
                  <td>
                    {t(`jurisdictions.${row.jurisdiction.kind}`)} {row.jurisdiction.code}
                  </td>
                  <td>
                    <code className="table-code">{row.operation}</code>
                  </td>
                  <td>
                    <code className="table-code">{row.adapterVersion}</code>
                  </td>
                  <td>
                    <Badge label={t(`capability.${row.status}`)} status="pending" />
                  </td>
                  <td>{date(row.activatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="dialog-description">{t('support.matrixDefault')}</p>
        <h3>{t('support.kindsTitle')}</h3>
        <ul className="fiscal-kinds">
          {data.kinds.map((kind) => (
            <li key={`${kind.model}-${kind.kind}`}>
              <Badge
                label={kind.supported ? t('support.kindSupported') : t('support.kindUnsupported')}
                status={kind.supported ? 'approved' : 'inactive'}
              />
              {t(`models.${kind.model}`)} · <code className="table-code">{kind.kind}</code>
            </li>
          ))}
        </ul>
        <MunicipalityLookup />
      </section>
      <section className="panel">
        <PanelHeading title={t('support.sourcesTitle')} copy={t('support.sourcesCopy')} />
        <ul className="fiscal-list">
          {overview.sourcePackages.map((row) => (
            <li key={row.id}>
              <span>{row.authority}</span>
              <small>
                {t('support.source', { published: date(row.publishedAt), days: row.ageDays })}
              </small>
            </li>
          ))}
        </ul>
        {!overview.sourcePackages.length ? <Empty copy={t('support.noSources')} /> : null}
      </section>
    </section>
  )
}

/** Asks the reviewed registry whether the national NFS-e issues for a municipality. */
function MunicipalityLookup() {
  const t = useTranslations('fiscal')
  const [answer, setAnswer] = useState<MunicipalityResolution | null>(null)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const data = new FormData(event.currentTarget)
    const code = String(data.get('municipality') ?? '').trim()
    const competence = String(data.get('competence') ?? '')
    if (!/^\d{7}$/.test(code)) {
      setError(t('preview.previewMunicipalityInvalid'))
      return
    }
    const response = await tracedFetch(
      'fiscal.nfse.registry.resolve',
      `${FISCAL_API}/nfse-registry/municipalities/${code}?competenceDate=${competence}`,
      { cache: 'no-store' },
    )
    if (!response.ok) {
      setError(t('support.lookupFailed'))
      return
    }
    setAnswer((await response.json()) as MunicipalityResolution)
  }

  return (
    <form className="dialog-form fiscal-lookup" onSubmit={submit}>
      <h3>{t('support.lookupTitle')}</h3>
      <div className="fiscal-form-row">
        <TextField
          defaultValue="3550308"
          label={t('preview.issuerMunicipality')}
          name="municipality"
          required
        />
        <TextField
          defaultValue={new Date().toISOString().slice(0, 10)}
          label={t('preview.competence')}
          name="competence"
          required
          type="date"
        />
      </div>
      <Button type="submit" variant="secondary">
        {t('support.lookup')}
      </Button>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {answer ? (
        <p role="status">
          {answer.route === 'national'
            ? t('support.routeNational', { code: answer.municipalityCode })
            : t('support.routeUnsupported', {
                code: answer.municipalityCode,
                reason: answer.reason ?? '—',
              })}
        </p>
      ) : null}
    </form>
  )
}
