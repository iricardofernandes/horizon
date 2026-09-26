import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { fiscalLinkedDocumentOutcome } from '../events/fiscal'
import { fiscalCalculationInputSchema } from './fiscal-calculation'
import {
  fiscalCorrectionLetterRequestSchema,
  fiscalLinkedOriginRequestSchema,
} from './fiscal-linked'

function complementInput(line: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    tenantId: randomUUID(),
    issuerEstablishmentId: randomUUID(),
    model: '55',
    environment: 'simulation',
    operation: 'rtc-v0057-model55-value-complement',
    purpose: 'complementary',
    referencedDocumentId: randomUUID(),
    issuer: { regime: 'normal', stateCode: '35', municipalityCode: '3550308' },
    recipient: { regime: 'normal', stateCode: '35', municipalityCode: '3550308', taxpayer: true },
    origin: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
    destination: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
    issueDate: '2026-09-26',
    currency: 'BRL',
    lines: [
      {
        id: randomUUID(),
        itemId: randomUUID(),
        quantity: '0',
        unitPrice: '0',
        discount: { amount: '0', currency: 'BRL' },
        charges: { amount: '0', currency: 'BRL' },
        classifications: { ncm: '09012100' },
        ...line,
      },
    ],
    ...extra,
  }
}

describe('Fiscal linked documents', () => {
  it('accepts a value complement only with zero quantity, zero price and a positive value', () => {
    expect(
      fiscalCalculationInputSchema.safeParse(complementInput({ complementValue: '12.5' })).success,
    ).toBe(true)
    expect(fiscalCalculationInputSchema.safeParse(complementInput({})).success).toBe(false)
    expect(
      fiscalCalculationInputSchema.safeParse(
        complementInput({ complementValue: '12.5', quantity: '1' }),
      ).success,
    ).toBe(false)
    expect(
      fiscalCalculationInputSchema.safeParse(
        complementInput({ complementValue: '12.5' }, { referencedDocumentId: undefined }),
      ).success,
    ).toBe(false)
  })

  it('refuses a complement value outside purpose complementary', () => {
    const input = complementInput(
      { complementValue: '1', quantity: '1', unitPrice: '1' },
      { purpose: 'normal', referencedDocumentId: undefined },
    )
    expect(fiscalCalculationInputSchema.safeParse(input).success).toBe(false)
  })

  it('discriminates linked origin requests by kind and requires a reason for a complement', () => {
    expect(
      fiscalLinkedOriginRequestSchema.safeParse({ kind: 'sale-return', shipmentId: randomUUID() })
        .success,
    ).toBe(true)
    expect(
      fiscalLinkedOriginRequestSchema.safeParse({ kind: 'remittance', intentId: randomUUID() })
        .success,
    ).toBe(false)
    expect(
      fiscalLinkedOriginRequestSchema.safeParse({
        kind: 'value-complement',
        referencedDocumentId: randomUUID(),
        reason: 'curto',
        lines: [{ lineId: randomUUID(), amount: { amount: '100', currency: 'BRL' } }],
      }).success,
    ).toBe(false)
  })

  it('requires the attestation on a correction letter', () => {
    const text = 'Corrige o endereço de entrega informado nos dados adicionais.'
    expect(fiscalCorrectionLetterRequestSchema.safeParse({ text, attestation: true }).success).toBe(
      true,
    )
    expect(
      fiscalCorrectionLetterRequestSchema.safeParse({ text, attestation: false }).success,
    ).toBe(false)
  })

  it('publishes a linked outcome without access keys or personal data', () => {
    const payload = {
      documentId: randomUUID(),
      rootDocumentId: randomUUID(),
      revision: 1,
      linkedOriginId: randomUUID(),
      kind: 'purchase-return',
      references: [{ type: 'supplier-invoice', importId: randomUUID() }],
      source: { module: 'procurement', documentType: 'receipt', id: randomUUID() },
      correlations: [
        {
          module: 'inventory',
          sourceEvent: 'procurement.receipt.returned',
          correlationId: randomUUID(),
        },
      ],
      model: '55',
      environment: 'simulation',
      simulated: true,
      adapterVersion: 'nfe55-simulator-v1',
      statusDigest: 'a'.repeat(64),
      observedAt: '2026-09-26T15:00:00.000Z',
      outcome: 'authorized',
      authorityReference: 'simulation:abc',
      protocolDigest: 'b'.repeat(64),
    }
    expect(fiscalLinkedDocumentOutcome.payload.safeParse(payload).success).toBe(true)
    expect(
      fiscalLinkedDocumentOutcome.payload.safeParse({ ...payload, accessKey: '3'.repeat(44) })
        .success,
    ).toBe(false)
    expect(
      fiscalLinkedDocumentOutcome.payload.safeParse({ ...payload, references: [] }).success,
    ).toBe(false)
  })
})
