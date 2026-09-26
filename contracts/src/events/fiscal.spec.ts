import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  fiscalDocumentAuthorized,
  fiscalDocumentCancelled,
  fiscalDocumentHomologationObserved,
  fiscalDocumentProductionOutcome,
  fiscalDocumentRejected,
  fiscalInboundMatched,
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

describe('homologation observation event', () => {
  it('carries only no-value, environment-tagged authority metadata', () => {
    const payload = {
      documentId: randomUUID(),
      exchangeId: randomUUID(),
      service: 'protocol',
      model: '55',
      environment: 'homologation',
      fiscalValue: false,
      adapterVersion: 'nfe55-sp-homologation-v1',
      decision: 'authorized',
      statusCode: '100',
      documentStatusCode: '100',
      eventStatusCode: null,
      requestDigest: 'a'.repeat(64),
      responseDigest: 'b'.repeat(64),
      protocolDigest: 'c'.repeat(64),
      observedAt: '2026-09-25T15:00:00.000Z',
    }
    expect(fiscalDocumentHomologationObserved.payload.safeParse(payload).success).toBe(true)
    expect(
      fiscalDocumentHomologationObserved.payload.safeParse({
        ...payload,
        environment: 'production',
      }).success,
    ).toBe(false)
    expect(
      fiscalDocumentHomologationObserved.payload.safeParse({ ...payload, fiscalValue: true })
        .success,
    ).toBe(false)
    expect(
      fiscalDocumentHomologationObserved.payload.safeParse({ ...payload, signedXml: '<NFe/>' })
        .success,
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

describe('Fiscal inbound reconciliation event', () => {
  const payload = {
    importId: randomUUID(),
    reconciliationId: randomUUID(),
    accessKey: '35260912345678000195550010000001011000001015',
    supplierPartyId: randomUUID(),
    decision: 'matched',
    receipts: [{ receiptId: randomUUID(), orderId: randomUUID() }],
    payableTitleIds: [],
    authorityEnvironment: 'homologation',
    signature: 'valid-unanchored',
    authorityStatus: 'unverified',
    comparisonDigest: 'c'.repeat(64),
    reviewedBy: 'user:reviewer',
    observedAt: '2026-09-26T15:00:00.000Z',
  } as const

  it('links a reviewed supplier NF-e to receipts without XML or personal data', () => {
    expect(fiscalInboundMatched.type).toBe('fiscal.inbound.matched')
    expect(fiscalInboundMatched.payload.parse(payload)).toEqual(payload)
    expect(fiscalInboundMatched.payload.parse({ ...payload, accessKey: null }).accessKey).toBeNull()
  })

  it('rejects raw XML, missing receipts and a verified authority claim', () => {
    expect(() => fiscalInboundMatched.payload.parse({ ...payload, xml: '<NFe/>' })).toThrow()
    expect(() => fiscalInboundMatched.payload.parse({ ...payload, receipts: [] })).toThrow()
    expect(() =>
      fiscalInboundMatched.payload.parse({ ...payload, authorityStatus: 'verified' }),
    ).toThrow()
  })
})
