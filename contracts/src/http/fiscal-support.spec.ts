import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  fiscalDocumentListSchema,
  fiscalDocumentSummarySchema,
  fiscalSupportOverviewSchema,
} from './fiscal-support'

const summary = {
  id: randomUUID(),
  model: 'nfse',
  environment: 'simulation',
  simulated: true,
  fiscalValue: false,
  status: 'unknown',
  originKind: 'service',
  establishmentId: randomUUID(),
  series: 1,
  number: 7,
  revision: 1,
  pending: {
    kind: 'status_query',
    state: 'pending',
    attemptCount: 2,
    nextAttemptAt: '2026-09-26T21:00:00.000Z',
  },
  lastRejectionCode: null,
  statusUrl: '/fiscal/service-documents/x',
  createdAt: '2026-09-26T20:00:00.000Z',
  updatedAt: '2026-09-26T20:01:00.000Z',
}

describe('fiscal support read models', () => {
  it('lists documents of every model and never claims fiscal value', () => {
    expect(fiscalDocumentSummarySchema.parse(summary).model).toBe('nfse')
    expect(() => fiscalDocumentSummarySchema.parse({ ...summary, fiscalValue: true })).toThrow()
    expect(() => fiscalDocumentSummarySchema.parse({ ...summary, accessKey: '1' })).toThrow()
    expect(
      fiscalDocumentListSchema.parse({ data: [summary], page: { hasMore: false } }).data,
    ).toHaveLength(1)
  })

  it('keeps the support overview to counts and ages', () => {
    const overview = {
      generatedAt: '2026-09-26T21:00:00.000Z',
      simulationOnly: true,
      queue: { pending: 1, leased: 0, oldestDueSeconds: 12, maxAttemptCount: 3 },
      documents: { authorized: 4, unknown: 1 },
      unknownOutcomes: 1,
      rejections: [{ code: 'E0014', count: 2, lastObservedAt: '2026-09-26T20:00:00.000Z' }],
      certificates: [
        {
          establishmentId: randomUUID(),
          fingerprint: 'a'.repeat(64),
          validUntil: '2026-10-10T00:00:00.000Z',
          daysRemaining: 13,
          state: 'expiring',
        },
      ],
      imports: { open: 1, blocked: 0, reconciled: 2 },
      outbox: { undelivered: 0, oldestUndeliveredSeconds: 0 },
      capabilities: [
        {
          id: randomUUID(),
          model: 'nfse',
          environment: 'simulation',
          establishmentId: randomUUID(),
          jurisdiction: { kind: 'municipality', code: '3550308' },
          operation: 'service-provision',
          adapterVersion: 'nfse-national-simulator-v1',
          status: 'simulated',
          activatedAt: '2026-09-26T21:00:00.000Z',
        },
      ],
      sourcePackages: [
        {
          id: randomUUID(),
          authority: 'Receita Federal',
          publishedAt: '2026-01-15',
          importedAt: '2026-09-21T10:00:00.000Z',
          ageDays: 5,
        },
      ],
    }
    expect(fiscalSupportOverviewSchema.parse(overview).queue.oldestDueSeconds).toBe(12)
    expect(() =>
      fiscalSupportOverviewSchema.parse({ ...overview, documents: { approved: 1 } }),
    ).toThrow()
    expect(() =>
      fiscalSupportOverviewSchema.parse({ ...overview, issuerTaxId: '12345678000195' }),
    ).toThrow()
  })
})
