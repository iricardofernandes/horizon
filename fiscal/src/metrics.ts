import { metrics } from '@opentelemetry/api'
import type { FiscalSupport, FiscalSupportTotals } from './support'

/**
 * Fiscal domain metrics (Phase 48). No label names a tenant, document, key or party:
 * labels are bounded values only, and per-tenant detail stays behind the authenticated
 * support read (ADR 0055).
 */
const meter = metrics.getMeter('fiscal.support')

const authorityOutcomes = meter.createCounter('fiscal_authority_outcomes', {
  description: 'Final authority observations by model, command family and outcome.',
})
const authorityLatency = meter.createHistogram('fiscal_authorization_latency_seconds', {
  description: 'Seconds from the first command of a document to its final authority outcome.',
  advice: { explicitBucketBoundaries: [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900, 3600] },
})
const xmlValidationFailures = meter.createCounter('fiscal_xml_validation_failures', {
  description: 'XML documents refused by a pinned schema, by schema family.',
})
const objectStoreFailures = meter.createCounter('fiscal_object_store_failures', {
  description: 'Artifact object-store operations that failed, by operation.',
})

export type XmlSchemaFamily = 'nfe' | 'nfe-event' | 'nfse' | 'sefaz-response' | 'inbound'

/** A code shaped like an authority code is kept; anything else is `other`. */
export function rejectionLabel(code: string | null | undefined): string {
  if (!code) return 'none'
  return /^[A-Z0-9_]{1,24}$/.test(code) ? code : 'other'
}

export function recordAuthorityOutcome(input: {
  model: string
  family: 'issuance' | 'cancellation'
  outcome: 'authorized' | 'rejected' | 'cancelled'
  rejectionCode: string | null | undefined
  latencySeconds: number | null
}): void {
  const model = ['55', '65', 'nfse'].includes(input.model) ? input.model : 'other'
  const labels = { model, family: input.family, outcome: input.outcome }
  authorityOutcomes.add(1, {
    ...labels,
    rejection_code: input.outcome === 'rejected' ? rejectionLabel(input.rejectionCode) : 'none',
  })
  if (input.latencySeconds !== null && Number.isFinite(input.latencySeconds))
    authorityLatency.record(Math.max(0, input.latencySeconds), labels)
}

export function recordXmlValidationFailure(family: XmlSchemaFamily): void {
  xmlValidationFailures.add(1, { schema: family })
}

export function recordObjectStoreFailure(operation: 'write' | 'read'): void {
  objectStoreFailures.add(1, { operation })
}

/**
 * Observable gauges read a snapshot refreshed on an interval, so a Prometheus scrape never
 * waits on the database. A failed refresh keeps the previous snapshot and counts itself.
 */
export function startSupportGauges(
  support: Pick<FiscalSupport, 'totals'>,
  tenantIds: readonly string[],
  intervalMilliseconds = 15_000,
): () => void {
  let totals: FiscalSupportTotals | null = null
  const refreshFailures = meter.createCounter('fiscal_support_refresh_failures', {
    description: 'Support snapshot refreshes that failed.',
  })
  const refresh = () =>
    support
      .totals(tenantIds)
      .then((value) => {
        totals = value
      })
      .catch(() => refreshFailures.add(1))
  void refresh()
  const timer = setInterval(() => void refresh(), intervalMilliseconds)
  timer.unref()

  const gauge = (
    name: string,
    description: string,
    read: (value: FiscalSupportTotals) => number | null,
  ) =>
    meter.createObservableGauge(name, { description }).addCallback((result) => {
      if (!totals) return
      const value = read(totals)
      if (value !== null) result.observe(value)
    })
  gauge('fiscal_queue_pending', 'Dispatch commands waiting for a worker.', (t) => t.queuePending)
  gauge('fiscal_queue_leased', 'Dispatch commands held by a worker.', (t) => t.queueLeased)
  gauge(
    'fiscal_queue_oldest_due_seconds',
    'Seconds the oldest due dispatch command has waited.',
    (t) => t.queueOldestDueSeconds,
  )
  gauge(
    'fiscal_unknown_outcomes',
    'Documents whose authority outcome is not known yet.',
    (t) => t.unknownOutcomes,
  )
  gauge(
    'fiscal_certificate_min_days_remaining',
    'Days until the first active establishment certificate expires.',
    (t) => t.certificateMinDaysRemaining,
  )
  gauge(
    'fiscal_certificates_expiring',
    'Active certificates inside the expiry warning window.',
    (t) => t.certificatesExpiring,
  )
  gauge(
    'fiscal_certificates_expired',
    'Active certificates already expired.',
    (t) => t.certificatesExpired,
  )
  gauge(
    'fiscal_imports_unmatched',
    'Supplier NF-e imports not reconciled with a receipt.',
    (t) => t.importsOpen + t.importsBlocked,
  )
  gauge(
    'fiscal_imports_blocked',
    'Supplier NF-e imports blocked by an open conflict.',
    (t) => t.importsBlocked,
  )
  gauge(
    'fiscal_service_intakes_blocked',
    'Services billed in Sales whose NFS-e is blocked until a person acts.',
    (t) => t.serviceIntakesBlocked,
  )
  gauge(
    'fiscal_service_intakes_cancellation_refused',
    'Services withdrawn in Sales whose NFS-e could no longer be cancelled.',
    (t) => t.serviceIntakesCancellationRefused,
  )
  gauge(
    'fiscal_outbox_undelivered',
    'Committed Fiscal events not yet published.',
    (t) => t.outboxUndelivered,
  )
  gauge(
    'fiscal_outbox_oldest_seconds',
    'Seconds the oldest undelivered Fiscal event has waited.',
    (t) => t.outboxOldestSeconds,
  )
  gauge(
    'fiscal_source_package_max_age_days',
    'Days since the oldest-imported source package was imported.',
    (t) => t.sourcePackageMaxAgeDays,
  )
  return () => clearInterval(timer)
}
