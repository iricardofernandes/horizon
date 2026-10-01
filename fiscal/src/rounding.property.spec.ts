import { describe, expect, it } from 'vitest'
import { calculateFiscal, type ResolvedRuleSet } from './calculation'

/**
 * The rounding exploit of Phase O's threat model (Phase 89): splitting a sale into many small
 * lines so each line's tax rounds away. Each component is rounded once per line, as the
 * NF-e states it per item, so a document's tax can differ from its exact total by at most
 * half a minor unit per line, never more; and every line's amount is its exact value,
 * rounded once.
 */

function generator(seed: number) {
  let state = seed >>> 0
  return (max: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state % max
  }
}

const base = {
  schemaVersion: 1,
  tenantId: '018f5d4e-0000-7000-8000-000000000001',
  issuerEstablishmentId: '018f5d4e-0000-7000-8000-000000000002',
  model: '55',
  environment: 'simulation',
  operation: 'illustrative-internal-sale',
  purpose: 'normal',
  issuer: { regime: 'normal', stateCode: '35', municipalityCode: '3550308' },
  recipient: { regime: 'normal', stateCode: '35', municipalityCode: '3550308', taxpayer: true },
  origin: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
  destination: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
  issueDate: '2026-09-21',
  currency: 'BRL',
} as const

const id = (index: number) => `018f5d4e-0000-7000-8000-${String(index).padStart(12, '0')}`

describe('rounding cannot be gamed by splitting lines (Phase 89)', () => {
  it('keeps every document within half a minor unit per line of its exact tax', () => {
    const next = generator(20261001)
    for (let run = 0; run < 300; run += 1) {
      const count = 1 + next(40)
      const rate = { numerator: String(1 + next(250)), denominator: '1000' }
      const lines = Array.from({ length: count }, (_, index) => ({
        id: id(index + 1),
        itemId: id(9000 + index),
        quantity: String(1 + next(5)),
        unitPrice: `${next(3)}.${String(next(100)).padStart(2, '0')}`,
        discount: { amount: '0', currency: 'BRL' },
        charges: { amount: '0', currency: 'BRL' },
        classifications: { ncm: '85094010' },
        taxFacts: {},
      }))
      const rules: ResolvedRuleSet = {
        schemaVersion: 1,
        currencyMinorUnitScale: 2,
        explanationTemplateVersion: 'fiscal-explanation-v1',
        lines: Object.fromEntries(
          lines.map((line) => [
            line.id,
            [
              {
                group: 'legacy' as const,
                code: 'ILLUSTRATIVE_TAX',
                rate,
                formula: 'LINE_NET_TIMES_RATE' as const,
                rule: { id: id(8000), version: 1 },
                source: {
                  packageId: id(8001),
                  digest: 'a'.repeat(64),
                  uri: 'https://example.invalid/illustrative-source',
                  section: 'property test',
                  approved: true,
                },
              },
            ],
          ]),
        ),
      }
      const outcome = calculateFiscal({ ...base, lines }, rules)
      if (!outcome.supported) throw new Error(outcome.detail)
      // Exact sum of the unrounded amounts, as a fraction over a common denominator (1000).
      let exactThousandths = 0n
      let rounded = 0n
      for (const line of outcome.lines) {
        const [component] = line.components.legacy
        if (!component) throw new Error('missing component')
        const unrounded = component.unrounded
        const scaled = (BigInt(unrounded.numerator) * 1000n) / BigInt(unrounded.denominator)
        expect((BigInt(unrounded.numerator) * 1000n) % BigInt(unrounded.denominator)).toBe(0n)
        exactThousandths += scaled
        rounded += BigInt(component.amount.amount)
        // Each line: its own exact value, rounded once, half away from zero.
        const twice = (BigInt(unrounded.numerator) * 2n) / BigInt(unrounded.denominator)
        expect(BigInt(component.amount.amount)).toBe((twice + 1n) / 2n)
      }
      const difference = rounded * 1000n - exactThousandths
      const bound = BigInt(outcome.lines.length) * 500n
      expect(difference <= bound && difference >= -bound).toBe(true)
    }
  })
})
