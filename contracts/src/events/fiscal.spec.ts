import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  fiscalDocumentAuthorized,
  fiscalDocumentCancelled,
  fiscalDocumentProductionOutcome,
  fiscalDocumentRejected,
} from './fiscal'

const base = {
  documentId: randomUUID(),
  rootDocumentId: randomUUID(),
  revision: 1,
  originModule: 'sales',
  originDocumentType: 'shipment',
  originId: randomUUID(),
  originPurpose: 'original',
  model: '55',
  environment: 'simulation',
  simulated: true,
  adapterVersion: 'nfe55-simulator-v1',
  statusDigest: 'a'.repeat(64),
  observedAt: '2026-09-22T15:00:00.000Z',
} as const

describe('Fiscal simulation status events', () => {
  it('uses simulation-specific event names', () => {
    expect(fiscalDocumentAuthorized.type).toBe('fiscal.document.simulation-authorized')
    expect(fiscalDocumentRejected.type).toBe('fiscal.document.simulation-rejected')
    expect(fiscalDocumentCancelled.type).toBe('fiscal.document.simulation-cancelled')
  })
  it('publishes an explicit simulated authorization with retained protocol evidence', () => {
    expect(
      fiscalDocumentAuthorized.payload.parse({
        ...base,
        authorityReference: 'simulation:authorization:1',
        protocolDigest: 'b'.repeat(64),
      }),
    ).toMatchObject({ simulated: true, environment: 'simulation', model: '55' })
  })

  it('keeps rejection and cancellation evidence distinct', () => {
    expect(
      fiscalDocumentRejected.payload.safeParse({
        ...base,
        authorityReference: null,
        rejectionCode: 'SIM-422',
        rejectionReason: 'Deterministic fixture rejection',
        responseDigest: 'c'.repeat(64),
      }).success,
    ).toBe(true)
    expect(
      fiscalDocumentCancelled.payload.safeParse({
        ...base,
        cancellationReference: 'simulation:cancellation:1',
        cancellationProtocolDigest: 'd'.repeat(64),
      }).success,
    ).toBe(true)
  })

  it('rejects production-looking or unlabelled simulation facts', () => {
    const payload = {
      ...base,
      authorityReference: 'simulation:authorization:1',
      protocolDigest: 'b'.repeat(64),
    }
    expect(
      fiscalDocumentAuthorized.payload.safeParse({ ...payload, environment: 'production' }).success,
    ).toBe(false)
    expect(
      fiscalDocumentAuthorized.payload.safeParse({ ...payload, simulated: false }).success,
    ).toBe(false)
  })
})

describe('future production release event', () => {
  it('requires an exact production origin and authority evidence', () => {
    const payload = {
      documentId: randomUUID(),
      documentRevision: 1,
      originModule: 'sales',
      originId: randomUUID(),
      originDigest: 'a'.repeat(64),
      orderVersion: 3,
      establishmentId: randomUUID(),
      model: '55',
      environment: 'production',
      outcome: 'authorized',
      authorityReference: 'protocol:123',
      responseDigest: 'b'.repeat(64),
      protocolDigest: 'c'.repeat(64),
      observedAt: '2026-09-23T15:00:00.000Z',
    }
    expect(fiscalDocumentProductionOutcome.payload.safeParse(payload).success).toBe(true)
    expect(
      fiscalDocumentProductionOutcome.payload.safeParse({ ...payload, environment: 'homologation' })
        .success,
    ).toBe(false)
    expect(
      fiscalDocumentProductionOutcome.payload.safeParse({ ...payload, originDigest: null }).success,
    ).toBe(false)
  })
})
