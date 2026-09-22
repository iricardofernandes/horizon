import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { fiscalCalculationInputSchema } from './fiscal-calculation'

function validInput() {
  return {
    schemaVersion: 1 as const,
    tenantId: randomUUID(),
    issuerEstablishmentId: randomUUID(),
    issuerProfileRevision: 3,
    recipientPartyId: randomUUID(),
    recipientProfileRevision: 7,
    model: '55' as const,
    environment: 'simulation' as const,
    operation: 'internal-sale',
    purpose: 'normal' as const,
    issuer: { regime: 'normal', stateCode: '35', municipalityCode: '3550308' },
    recipient: {
      regime: 'normal',
      stateCode: '35',
      municipalityCode: '3550308',
      taxpayer: true,
    },
    origin: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
    destination: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
    issueDate: '2026-09-21',
    currency: 'BRL',
    lines: [
      {
        id: randomUUID(),
        itemId: randomUUID(),
        classificationRevision: 2,
        quantity: '2.500000',
        unitPrice: '10.25',
        discount: { amount: '25', currency: 'BRL' },
        charges: { amount: '0', currency: 'BRL' },
        classifications: { ncm: '12345678' },
        taxFacts: {},
      },
    ],
  }
}

describe('Fiscal calculation input', () => {
  it('accepts explicit, canonical tax facts without converting dates or decimals to numbers', () => {
    const input = validInput()
    expect(fiscalCalculationInputSchema.parse(input)).toEqual(input)
  })

  it('rejects non-canonical and over-precise decimals', () => {
    const leadingZero = validInput()
    const leadingZeroLine = leadingZero.lines[0]
    if (!leadingZeroLine) throw new Error('fixture has no line')
    leadingZeroLine.quantity = '01.5'
    expect(fiscalCalculationInputSchema.safeParse(leadingZero).success).toBe(false)

    const overPrecise = validInput()
    const overPreciseLine = overPrecise.lines[0]
    if (!overPreciseLine) throw new Error('fixture has no line')
    overPreciseLine.unitPrice = '1.0000001'
    expect(fiscalCalculationInputSchema.safeParse(overPrecise).success).toBe(false)
  })

  it('requires a return reference and exactly one item or service identity', () => {
    const input = validInput()
    const line = input.lines[0]
    if (!line) throw new Error('fixture has no line')
    const returned = {
      ...input,
      purpose: 'return' as const,
      lines: [{ ...line, serviceId: randomUUID() }],
    }
    expect(fiscalCalculationInputSchema.safeParse(returned).success).toBe(false)
  })

  it('rejects line money in a different currency', () => {
    const input = validInput()
    const line = input.lines[0]
    if (!line) throw new Error('fixture has no line')
    line.discount.currency = 'USD'
    expect(fiscalCalculationInputSchema.safeParse(input).success).toBe(false)
  })
})
