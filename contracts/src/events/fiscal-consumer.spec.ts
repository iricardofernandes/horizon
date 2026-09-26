import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  fiscalConsumerProblemCodeSchema,
  fiscalDocumentCreateRequestSchema,
  fiscalDocumentCreateRequestV2Schema,
  fiscalDocumentKindEntrySchema,
  fiscalDocumentKindEntryV2Schema,
} from '../http'
import { fiscalConsumerDocumentOutcome, fiscalDocumentAuthorized } from './fiscal'

const shipmentId = randomUUID()
const fact = {
  documentId: randomUUID(),
  rootDocumentId: randomUUID(),
  revision: 1,
  source: { module: 'sales', documentType: 'shipment', id: shipmentId },
  correlations: [
    { module: 'inventory', sourceEvent: 'sales.shipment.dispatched', correlationId: shipmentId },
    { module: 'financial', sourceEvent: 'sales.shipment.dispatched', correlationId: shipmentId },
  ],
  model: '65',
  environment: 'simulation',
  simulated: true,
  adapterVersion: 'nfce65-simulator-v1',
  statusDigest: 'a'.repeat(64),
  observedAt: '2026-09-26T15:00:00.000Z',
} as const

describe('NFC-e model 65 consumer outcomes', () => {
  it('publishes each outcome under its own event without the model 55 facts', () => {
    expect(fiscalConsumerDocumentOutcome.type).toBe('fiscal.consumer-document.simulation-outcome')
    expect(
      fiscalConsumerDocumentOutcome.payload.parse({
        ...fact,
        outcome: 'authorized',
        authorityReference: 'simulation:nfce:1',
        protocolDigest: 'b'.repeat(64),
      }),
    ).toMatchObject({ model: '65', outcome: 'authorized' })
    expect(
      fiscalConsumerDocumentOutcome.payload.safeParse({
        ...fact,
        outcome: 'rejected',
        authorityReference: null,
        rejectionCode: 'SIMULATED_LATE_EMISSION',
        protocolDigest: null,
      }).success,
    ).toBe(true)
    // The model 55 events keep their literal model.
    expect(
      fiscalDocumentAuthorized.payload.safeParse({
        documentId: fact.documentId,
        rootDocumentId: fact.rootDocumentId,
        revision: 1,
        originModule: 'sales',
        originDocumentType: 'shipment',
        originId: shipmentId,
        originPurpose: 'original',
        model: '65',
        environment: 'simulation',
        simulated: true,
        adapterVersion: 'nfce65-simulator-v1',
        statusDigest: 'a'.repeat(64),
        observedAt: fact.observedAt,
        authorityReference: 'simulation:nfce:1',
        protocolDigest: 'b'.repeat(64),
      }).success,
    ).toBe(false)
  })

  it('carries no access key, QR code or consumer data', () => {
    for (const extra of [
      { accessKey: '3'.repeat(44) },
      { qrCode: 'https://example.invalid/?p=1' },
      { consumerTaxId: '12345678909' },
    ])
      expect(
        fiscalConsumerDocumentOutcome.payload.safeParse({
          ...fact,
          ...extra,
          outcome: 'authorized',
          authorityReference: 'simulation:nfce:1',
          protocolDigest: 'b'.repeat(64),
        }).success,
      ).toBe(false)
  })

  it('accepts model 65 drafts only in the version 2 request', () => {
    const request = {
      origin: { kind: 'sales', intentId: randomUUID() },
      model: '65',
      environment: 'simulation',
      establishmentId: randomUUID(),
      series: 1,
    } as const
    expect(fiscalDocumentCreateRequestV2Schema.safeParse(request).success).toBe(true)
    expect(fiscalDocumentCreateRequestSchema.safeParse(request).success).toBe(false)
    expect(
      fiscalDocumentCreateRequestV2Schema.safeParse({ ...request, model: 'nfse' }).success,
    ).toBe(false)
  })

  it('names the model 65 kinds and refusal codes', () => {
    const entry = {
      kind: 'consumer-sale',
      model: '65',
      supported: true,
      purpose: '1',
      direction: 'outbound',
      operation: 'consumer-sale',
      reference: 'none',
      source: 'sales.fiscal-origin.recorded (original) to a final consumer',
      stockOwner: { module: 'inventory', sourceEvent: 'sales.shipment.dispatched' },
      moneyOwner: { module: 'financial', sourceEvent: 'sales.shipment.dispatched' },
      reason: null,
    }
    expect(fiscalDocumentKindEntryV2Schema.safeParse(entry).success).toBe(true)
    expect(fiscalDocumentKindEntrySchema.safeParse(entry).success).toBe(false)
    expect(fiscalConsumerProblemCodeSchema.options).toContain('CANCELLATION_WINDOW_ELAPSED')
  })
})
