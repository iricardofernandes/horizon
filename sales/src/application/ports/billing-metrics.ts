/**
 * What billing runs report to operators (Phase 52). Labels are bounded values: never a
 * tenant, contract or customer (ADR 0055).
 */
export interface BillingMetrics {
  decided(outcome: 'billed' | 'skipped' | 'refused', reason: string | null): void
  runFinished(seconds: number): void
}

export const NO_BILLING_METRICS: BillingMetrics = {
  decided: () => undefined,
  runFinished: () => undefined,
}
