import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  fiscalArtifactMetadataSchema,
  fiscalCancellationRequestSchema,
  fiscalCapabilityListSchema,
  fiscalDocumentCreateRequestSchema,
  fiscalDocumentSchema,
  fiscalManualOriginRequestSchema,
} from './fiscal-lifecycle'

const digest = 'a'.repeat(64)
const establishmentId = randomUUID()

describe('Fiscal lifecycle HTTP contracts', () => {
  it('describes one exact simulated capability and keeps unsupported as the default', () => {
    const value = {
      defaultStatus: 'unsupported',
      supported: [
        {
          id: randomUUID(),
          model: '55',
          environment: 'simulation',
          establishmentId,
          jurisdiction: { kind: 'uf', code: 'SP' },
          operation: 'normal-sale',
          adapterVersion: 'nfe55-simulator-v1',
          status: 'simulated',
          sourceManifestDigest: digest,
          schemaPackageDigest: 'b'.repeat(64),
          calculationFixtureId: 'rtc-v0057-model55-normal-sale-sp-2026-01',
          evidenceDigest: 'c'.repeat(64),
          activatedAt: '2026-09-22T15:00:00.000Z',
        },
      ],
    } as const
    expect(fiscalCapabilityListSchema.parse(value)).toEqual(value)
    expect(
      fiscalCapabilityListSchema.safeParse({
        ...value,
        supported: [{ ...value.supported[0], environment: 'production' }],
      }).success,
    ).toBe(false)
  })

  it('accepts only model-55 simulation drafts from typed origins', () => {
    const request = {
      origin: { kind: 'sales', intentId: randomUUID() },
      model: '55',
      environment: 'simulation',
      establishmentId,
      series: 1,
    } as const
    expect(fiscalDocumentCreateRequestSchema.parse(request)).toEqual(request)
    expect(fiscalDocumentCreateRequestSchema.safeParse({ ...request, model: '65' }).success).toBe(
      false,
    )
    expect(
      fiscalDocumentCreateRequestSchema.safeParse({ ...request, environment: 'production' })
        .success,
    ).toBe(false)
  })

  it('freezes manual origins from owner revisions instead of caller tax results', () => {
    const request = {
      establishmentId,
      issuerProfileRevision: 3,
      recipientPartyId: randomUUID(),
      recipientProfileRevision: 2,
      issueDate: '2026-09-22',
      operation: 'normal-sale',
      purpose: 'normal',
      reason: 'Approved local simulation scenario',
      lines: [
        {
          lineId: randomUUID(),
          itemId: randomUUID(),
          catalogRevision: 4,
          quantity: '1.250000',
          unitPrice: { amount: '10000', currency: 'BRL' },
        },
      ],
    } as const
    expect(fiscalManualOriginRequestSchema.parse(request)).toEqual(request)
    expect(
      fiscalManualOriginRequestSchema.safeParse({ ...request, taxTotal: 'caller-controlled' })
        .success,
    ).toBe(false)
  })

  it('labels every document and artifact as simulated', () => {
    const document = {
      id: randomUUID(),
      rootDocumentId: randomUUID(),
      predecessorDocumentId: null,
      revision: 1,
      origin: { kind: 'sales', intentId: randomUUID() },
      status: 'queued',
      simulated: true,
      model: '55',
      environment: 'simulation',
      establishmentId,
      series: 1,
      number: 1,
      accessKey: '3'.repeat(44),
      snapshotDigest: digest,
      calculationDigest: 'b'.repeat(64),
      signedXmlDigest: 'c'.repeat(64),
      adapterVersion: 'nfe55-simulator-v1',
      schemaPackageDigest: 'd'.repeat(64),
      statusUrl: '/fiscal/documents/3/status',
      createdAt: '2026-09-22T15:00:00.000Z',
    } as const
    expect(fiscalDocumentSchema.parse(document)).toEqual(document)
    expect(fiscalDocumentSchema.safeParse({ ...document, simulated: false }).success).toBe(false)
    expect(
      fiscalArtifactMetadataSchema.safeParse({
        documentId: document.id,
        kind: 'signed_xml',
        digest,
        byteSize: 1024,
        mediaType: 'application/xml',
        sourceSchema: 'PL_010f_v1.04/nfe_v4.00.xsd',
        simulated: true,
        createdAt: document.createdAt,
      }).success,
    ).toBe(true)
  })

  it('constrains cancellation reasons to the public authority-sized range', () => {
    expect(fiscalCancellationRequestSchema.safeParse({ reason: '123456789012345' }).success).toBe(
      true,
    )
    expect(fiscalCancellationRequestSchema.safeParse({ reason: 'too short' }).success).toBe(false)
    expect(fiscalCancellationRequestSchema.safeParse({ reason: 'x'.repeat(256) }).success).toBe(
      false,
    )
  })
})
