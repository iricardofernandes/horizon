import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  fiscalNfseRegistryVersionRequestSchema,
  fiscalServiceDocumentSchema,
  fiscalServiceOriginRequestSchema,
  fiscalServiceProfileRequestSchema,
  fiscalServiceSubstitutionRequestSchema,
} from '../http'
import { fiscalServiceDocumentOutcome } from './fiscal'

const fact = {
  documentId: randomUUID(),
  rootDocumentId: randomUUID(),
  revision: 1,
  serviceOriginId: randomUUID(),
  sourceKey: null,
  municipalityCode: '3550308',
  competence: '2026-09',
  model: 'nfse',
  environment: 'simulation',
  simulated: true,
  adapterVersion: 'nfse-national-simulator-v1',
  statusDigest: 'a'.repeat(64),
  observedAt: '2026-09-26T18:00:00.000Z',
} as const

describe('national NFS-e contracts', () => {
  it('publishes service outcomes without an access key or recipient data', () => {
    expect(fiscalServiceDocumentOutcome.type).toBe('fiscal.service-document.simulation-outcome')
    const authorized = fiscalServiceDocumentOutcome.payload.parse({
      ...fact,
      outcome: 'authorized',
      authorityReference: 'simulation:nfse:1',
      protocolDigest: 'b'.repeat(64),
      substitutesDocumentId: null,
    })
    expect(JSON.stringify(authorized)).not.toMatch(/[0-9]{50}/)
    expect(() =>
      fiscalServiceDocumentOutcome.payload.parse({
        ...fact,
        outcome: 'authorized',
        authorityReference: 'simulation:nfse:1',
        protocolDigest: 'b'.repeat(64),
        substitutesDocumentId: null,
        nfseKey: '3'.repeat(50),
      }),
    ).toThrow()
    const substituted = fiscalServiceDocumentOutcome.payload.parse({
      ...fact,
      outcome: 'cancelled',
      authorityReference: 'simulation:nfse:1',
      protocolDigest: 'b'.repeat(64),
      cancellation: { kind: 'substitution', substitutedBy: randomUUID() },
    })
    expect(substituted.outcome).toBe('cancelled')
    expect(() =>
      fiscalServiceDocumentOutcome.payload.parse({ ...fact, model: '55', outcome: 'rejected' }),
    ).toThrow()
  })

  it('keys a service origin by an optional contract-period source', () => {
    const request = {
      establishmentId: randomUUID(),
      issuerProfileRevision: 1,
      recipientPartyId: randomUUID(),
      recipientProfileRevision: 1,
      serviceItemId: randomUUID(),
      serviceProfileRevision: 1,
      competenceDate: '2026-09-01',
      amount: { amount: '150000', currency: 'BRL' },
      description: 'Desenvolvimento de sistema sob medida',
      reason: 'Serviço prestado e revisado pelo emissor',
    }
    expect(fiscalServiceOriginRequestSchema.parse(request)).toMatchObject(request)
    expect(
      fiscalServiceOriginRequestSchema.parse({
        ...request,
        sourceKey: {
          module: 'contracts',
          documentType: 'contract-period',
          id: randomUUID(),
          period: '2026-09',
        },
      }).sourceKey?.period,
    ).toBe('2026-09')
    expect(() =>
      fiscalServiceOriginRequestSchema.parse({
        ...request,
        sourceKey: { module: 'contracts', documentType: 'x1', id: randomUUID(), period: '2026-13' },
      }),
    ).toThrow()
  })

  it('accepts only taxable services with national and NBS codes', () => {
    const profile = {
      itemId: randomUUID(),
      nationalTaxCode: '010101',
      nbsCode: '115022000',
      issTaxation: '1',
      description: 'Análise e desenvolvimento de sistemas',
      effectiveFrom: '2026-01-01',
      reason: 'Classificação revisada do serviço',
    }
    expect(fiscalServiceProfileRequestSchema.parse(profile).nationalTaxCode).toBe('010101')
    expect(() =>
      fiscalServiceProfileRequestSchema.parse({ ...profile, issTaxation: '2' }),
    ).toThrow()
    expect(() =>
      fiscalServiceProfileRequestSchema.parse({ ...profile, nbsCode: '1.1502' }),
    ).toThrow()
  })

  it('requires a text for substitution reason 99 and a DPS identifier shape', () => {
    const correctedOrigin = { serviceOriginId: randomUUID() }
    expect(() =>
      fiscalServiceSubstitutionRequestSchema.parse({ reasonCode: '99', correctedOrigin }),
    ).toThrow()
    expect(
      fiscalServiceSubstitutionRequestSchema.parse({ reasonCode: '01', correctedOrigin })
        .reasonCode,
    ).toBe('01')
    expect(() =>
      fiscalNfseRegistryVersionRequestSchema.parse({
        sourceUri: 'https://www.gov.br/nfse',
        sourceDigest: 'c'.repeat(64),
        publishedOn: '2026-09-18',
        entries: [],
      }),
    ).toThrow()
    const document = {
      id: randomUUID(),
      rootDocumentId: randomUUID(),
      predecessorDocumentId: null,
      revision: 1,
      serviceOriginId: randomUUID(),
      substitutesDocumentId: null,
      substitutedByDocumentId: null,
      status: 'authorized',
      model: 'nfse',
      environment: 'simulation',
      simulated: true,
      fiscalValue: false,
      establishmentId: randomUUID(),
      municipalityCode: '3550308',
      competenceDate: '2026-09-01',
      series: 1,
      number: 1,
      dpsId: `DPS3550308${'2'}${'1'.repeat(14)}00001${'1'.padStart(15, '0')}`,
      nfseKey: '3'.repeat(50),
      nfseNumber: '1',
      generatedAt: '2026-09-26T18:00:00.000Z',
      snapshotDigest: 'd'.repeat(64),
      calculationDigest: null,
      dpsXmlDigest: null,
      adapterVersion: null,
      statusUrl: '/fiscal/service-documents/x',
      createdAt: '2026-09-26T18:00:00.000Z',
    }
    expect(fiscalServiceDocumentSchema.parse(document).dpsId).toHaveLength(45)
    expect(() => fiscalServiceDocumentSchema.parse({ ...document, dpsId: 'DPS1' })).toThrow()
  })
})
