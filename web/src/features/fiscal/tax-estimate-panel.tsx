'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/state'
import { apiError } from '@/lib/api'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime, useMoney } from '@/lib/use-format'
import { FISCAL_API } from './types'

type Money = { amount: string; currency: string }

/** Fiscal's whole estimate, or the digest form a purchase order keeps of it. */
export type TaxEstimate = {
  estimatedAt?: string
  components: { group?: string; code: string; amount: Money; outcome?: string }[]
  totals?: { net: Money; tax: Money; chargedOnTop: Money; gross: Money }
  chargedOnTop?: Money
  inputDigest: string
  rulesDigest: string
  resultDigest: string
}

type Refusal = { supported: false; detail: string; missingDimension?: string }

/**
 * Fiscal's estimate of a document's taxes (Phase 87, ADR 0073), labeled as an estimate: it
 * helps a decision and is never the tax owed, which only Fiscal's lock fixes. The web asks
 * Fiscal and hands the answer to the document's owner, which keeps it with its digests.
 */
export function TaxEstimatePanel({
  recordedPath,
  request,
  canEstimate,
  readStored,
  onRecorded,
}: {
  /** Where the document keeps its estimate: PUT records a new one, and GET reads it. */
  recordedPath: string
  /** The draft to estimate, or null when this document cannot be estimated. */
  request: (() => Promise<unknown | null>) | null
  canEstimate: boolean
  /** Read the kept estimate from the document itself instead of asking GET. */
  readStored?: (() => Promise<TaxEstimate | null>) | undefined
  /** Called once a new estimate is recorded, so a parent reading it can reload. */
  onRecorded?: (() => Promise<void>) | undefined
}) {
  const t = useTranslations('fiscal')
  const [estimate, setEstimate] = useState<TaxEstimate | null>(null)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (readStored) {
      setEstimate(await readStored())
      return
    }
    const response = await tracedFetch('tax-estimate.read', recordedPath, { cache: 'no-store' })
    if (!response.ok) return setEstimate(null)
    const stored = (await response.json()) as { estimate: TaxEstimate }
    setEstimate(stored.estimate)
  }, [recordedPath, readStored])

  useEffect(() => {
    void load()
  }, [load])

  async function ask() {
    if (!request) return
    setBusy(true)
    setError('')
    setRefusal(null)
    try {
      const body = await request()
      if (!body) return setError(t('estimateUnavailable'))
      const answer = await tracedFetch('fiscal.estimate', `${FISCAL_API}/estimates`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      })
      if (!answer.ok) return setError(await apiError(answer, t('estimateFailed')))
      const result = (await answer.json()) as (TaxEstimate & { supported: true }) | Refusal
      if (!result.supported) return setRefusal(result)
      const recorded = await tracedFetch('tax-estimate.record', recordedPath, {
        method: 'PUT',
        headers: jsonHeaders(),
        // Only the digest: the owner reads the estimate back from Fiscal itself (Phase 91).
        body: JSON.stringify({ resultDigest: result.resultDigest }),
      })
      if (!recorded.ok) return setError(await apiError(recorded, t('estimateFailed')))
      await onRecorded?.()
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label={t('estimateTitle')} className="tax-estimate">
      <h3 className="document-section-title">{t('estimateTitle')}</h3>
      <p className="document-note">{t('estimateNote')}</p>
      {estimate ? (
        <EstimateFigures estimate={estimate} />
      ) : (
        <p className="document-note">{t('noEstimate')}</p>
      )}
      {refusal ? (
        <Notice
          copy={t('estimateRefused', {
            detail: refusal.detail,
            dimension: refusal.missingDimension ?? '—',
          })}
        />
      ) : null}
      {error ? <Notice copy={error} /> : null}
      {canEstimate && request ? (
        <Button disabled={busy} onClick={() => void ask()} variant="secondary">
          {t('estimateTaxes')}
        </Button>
      ) : null}
    </section>
  )
}

function EstimateFigures({ estimate }: { estimate: TaxEstimate }) {
  const t = useTranslations('fiscal')
  const money = useMoney()
  const dateTime = useDateTime()
  const currency = estimate.totals?.net.currency ?? estimate.chargedOnTop?.currency ?? 'BRL'
  const levied = estimate.components.filter(
    (component) => (component.outcome ?? 'levied') === 'levied',
  )
  const tax =
    estimate.totals?.tax.amount ??
    String(levied.reduce((sum, component) => sum + BigInt(component.amount.amount), 0n))
  const onTop = estimate.totals?.chargedOnTop.amount ?? estimate.chargedOnTop?.amount ?? '0'
  return (
    <>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('component')}</th>
              <th className="numeric">{t('amount')}</th>
            </tr>
          </thead>
          <tbody>
            {estimate.components.map((component) => {
              const outcome = component.outcome ?? 'levied'
              return (
                <tr key={`${component.group ?? ''}:${component.code}:${outcome}`}>
                  <td>
                    {component.code}
                    {outcome === 'levied' ? '' : ` · ${t(`outcome.${outcome}`)}`}
                  </td>
                  <td className="numeric">{money(component.amount.amount, currency)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <dl className="document-facts">
        <div>
          <dt>{t('estimatedTax')}</dt>
          <dd>{money(tax, currency)}</dd>
        </div>
        <div>
          <dt>{t('chargedOnTop')}</dt>
          <dd>{money(onTop, currency)}</dd>
        </div>
        {estimate.totals ? (
          <div>
            <dt>{t('estimatedGross')}</dt>
            <dd>{money(estimate.totals.gross.amount, currency)}</dd>
          </div>
        ) : null}
        {estimate.estimatedAt ? (
          <div>
            <dt>{t('estimatedAt')}</dt>
            <dd>{dateTime(estimate.estimatedAt)}</dd>
          </div>
        ) : null}
      </dl>
      <p className="document-note">
        {t('estimateDigest', { digest: estimate.resultDigest.slice(0, 12) })}
      </p>
    </>
  )
}

/** The establishment Fiscal calculates for: the one its active capability was reviewed for. */
export async function fiscalEstablishment(): Promise<string | null> {
  const response = await tracedFetch('fiscal.capabilities', `${FISCAL_API}/capabilities`, {
    cache: 'no-store',
  })
  if (!response.ok) return null
  const body = (await response.json()) as { supported: { establishmentId: string }[] }
  return body.supported[0]?.establishmentId ?? null
}
