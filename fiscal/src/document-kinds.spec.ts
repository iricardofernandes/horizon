import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { calculateFiscal, type ResolvedRuleSet } from './calculation'
import {
  DOCUMENT_KINDS,
  hasEventFlow,
  PHASE45_SCENARIOS,
  supportedKind,
  UnsupportedDocumentKind,
} from './document-kinds'

const lineId = randomUUID()

function input(purpose: 'return' | 'complementary', line: Record<string, string>) {
  return {
    schemaVersion: 1,
    tenantId: randomUUID(),
    issuerEstablishmentId: randomUUID(),
    model: '55',
    environment: 'simulation',
    operation:
      purpose === 'return'
        ? PHASE45_SCENARIOS['sale-return']
        : PHASE45_SCENARIOS['value-complement'],
    purpose,
    referencedDocumentId: randomUUID(),
    issuer: { regime: 'normal', stateCode: '35', municipalityCode: '3550308' },
    recipient: { regime: 'normal', stateCode: '35', municipalityCode: '3550308', taxpayer: true },
    origin: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
    destination: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
    issueDate: '2026-09-26',
    currency: 'BRL',
    lines: [
      {
        id: lineId,
        itemId: randomUUID(),
        discount: { amount: '0', currency: 'BRL' },
        charges: { amount: '0', currency: 'BRL' },
        classifications: { ncm: '09012100' },
        taxFacts: {},
        ...line,
      },
    ],
  }
}

function rules(formula: 'LINE_NET_TIMES_RATE' | 'RETURN_LINE_NET_TIMES_RATE'): ResolvedRuleSet {
  const source = {
    packageId: randomUUID(),
    digest: 'a'.repeat(64),
    uri: 'https://example.invalid/rtc',
    section: 'test',
    approved: true,
  }
  return {
    schemaVersion: 1,
    currencyMinorUnitScale: 2,
    explanationTemplateVersion: 'fiscal-explanation-v1',
    lines: {
      [lineId]: [
        {
          group: 'ibsCbs',
          code: 'CBS',
          rate: { numerator: '9', denominator: '1000' },
          formula,
          rule: { id: randomUUID(), version: 1 },
          source,
        },
      ],
    },
  }
}

describe('Fiscal document kinds', () => {
  it('refuses every kind without an owner fact, rule and capability', () => {
    for (const kind of ['remittance', 'adjustment', 'credit-note', 'debit-note', 'unknown'])
      expect(() => supportedKind(kind)).toThrow(UnsupportedDocumentKind)
    for (const entry of DOCUMENT_KINDS.filter((candidate) => !candidate.supported))
      expect(entry.reason).toMatch(/\w+/)
    expect(supportedKind('sale-return')).toMatchObject({ purpose: '4', direction: 'inbound' })
  })

  it('offers correction letters only to model 55', () => {
    expect(hasEventFlow('55', 'correction-letter')).toBe(true)
    expect(hasEventFlow('65', 'correction-letter')).toBe(false)
    expect(hasEventFlow('65', 'cancellation')).toBe(true)
    expect(supportedKind('consumer-sale')).toMatchObject({
      model: '65',
      operation: 'consumer-sale',
    })
    for (const kind of ['counter-sale', 'consumer-sale-offline'])
      expect(() => supportedKind(kind)).toThrow(UnsupportedDocumentKind)
    expect(hasEventFlow('nfse', 'cancellation')).toBe(false)
  })

  it('reverses tax on a return and computes a complement from its value alone', () => {
    const returned = calculateFiscal(
      input('return', { quantity: '2', unitPrice: '50' }),
      rules('RETURN_LINE_NET_TIMES_RATE'),
    )
    expect(returned.supported && returned.totals.gross.amount).toBe('-10000')
    expect(returned.supported && returned.totals.ibsCbsTax.amount).toBe('-90')

    const complement = calculateFiscal(
      input('complementary', { quantity: '0', unitPrice: '0', complementValue: '12.34' }),
      rules('LINE_NET_TIMES_RATE'),
    )
    expect(complement.supported && complement.totals.gross.amount).toBe('1234')
    expect(complement.supported && complement.totals.ibsCbsTax.amount).toBe('11')
  })

  it('refuses a return formula on a complement', () => {
    const outcome = calculateFiscal(
      input('complementary', { quantity: '0', unitPrice: '0', complementValue: '1' }),
      rules('RETURN_LINE_NET_TIMES_RATE'),
    )
    expect(outcome).toMatchObject({ supported: false, code: 'UNSUPPORTED_RULE' })
  })
})
