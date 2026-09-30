import { readFile } from 'node:fs/promises'
import type { FiscalCalculationInput } from '@horizon/contracts'
import { describe, expect, it } from 'vitest'
import { calculateFiscal, type ResolvedComponentRule, type ResolvedRuleSet } from './calculation'
import { integer, multiply, type Rational, roundHalfAwayFromZero } from './exact-decimal'
import {
  type Expression,
  evaluate,
  evaluateComponent,
  evaluationOrder,
  FORMULA_VERSION,
  lineValues,
  packageProblem,
  render,
  ruleExpressionSchema,
  sizeProblem,
} from './formula'
import { approvedPhase41ResolvedRules } from './phase41-approved-scenario'

const rate = (numerator: string, denominator: string): Expression => ({
  rate: { numerator, denominator },
})
const expression = (base: Expression, outcome?: string) =>
  ruleExpressionSchema.parse({ version: FORMULA_VERSION, base, ...(outcome ? { outcome } : {}) })

const line = lineValues({
  gross: 10_000n,
  discount: 500n,
  charges: 300n,
  net: 9_800n,
  quantity: '4',
})
const none = new Map<string, bigint>()
const value = (result: Rational) => `${result.numerator}/${result.denominator}`

describe('the formula vocabulary (ADR 0071)', () => {
  it('reads line values, component amounts and rational constants', () => {
    expect(value(evaluate({ line: 'net' }, line, none))).toBe('9800/1')
    expect(value(evaluate({ line: 'quantity' }, line, none))).toBe('4/1')
    expect(value(evaluate({ component: 'IPI' }, line, new Map([['IPI', 980n]])))).toBe('980/1')
    expect(value(evaluate(rate('18', '100'), line, none))).toBe('9/50')
  })

  it('sums, multiplies, and takes a minimum or a maximum', () => {
    expect(value(evaluate({ sum: [{ line: 'net' }, { line: 'charges' }] }, line, none))).toBe(
      '10100/1',
    )
    expect(value(evaluate({ product: [{ line: 'net' }, rate('1', '2')] }, line, none))).toBe(
      '4900/1',
    )
    expect(value(evaluate({ min: [{ line: 'net' }, { line: 'gross' }] }, line, none))).toBe(
      '9800/1',
    )
    expect(value(evaluate({ max: [{ line: 'net' }, { line: 'gross' }] }, line, none))).toBe(
      '10000/1',
    )
  })

  it('grosses a base up and reduces one', () => {
    // 9800 / (1 − 18/100) = 9800 / (82/100)
    expect(
      value(evaluate({ grossUp: { base: { line: 'net' }, rate: rate('18', '100') } }, line, none)),
    ).toBe('490000/41')
    expect(
      value(evaluate({ reduce: { base: { line: 'net' }, by: rate('60', '100') } }, line, none)),
    ).toBe('3920/1')
  })

  it('refuses a gross-up at a rate of one or more', () => {
    expect(() =>
      evaluate({ grossUp: { base: { line: 'net' }, rate: rate('1', '1') } }, line, none),
    ).toThrow(/below one/)
  })

  it('refuses unknown nodes and extra keys, and limits depth and size', () => {
    expect(
      ruleExpressionSchema.safeParse({ version: FORMULA_VERSION, base: { eval: 'x' } }).success,
    ).toBe(false)
    expect(
      ruleExpressionSchema.safeParse({ version: FORMULA_VERSION, base: { line: 'net', extra: 1 } })
        .success,
    ).toBe(false)
    let deep: Expression = { line: 'net' }
    for (let level = 0; level < 9; level++) deep = { sum: [deep, rate('0', '1')] }
    expect(sizeProblem(deep)).toMatch(/levels deep/)
    const wide: Expression = {
      sum: Array.from({ length: 8 }, () => ({
        sum: Array.from({ length: 8 }, () => ({ line: 'net' as const })),
      })),
    }
    expect(sizeProblem(wide)).toMatch(/nodes/)
    expect(ruleExpressionSchema.safeParse({ version: FORMULA_VERSION, base: wide }).success).toBe(
      false,
    )
  })

  it('renders an expression as a person reads it', () => {
    expect(
      render({
        grossUp: {
          base: { sum: [{ line: 'net' }, { component: 'IPI' }] },
          rate: rate('18', '100'),
        },
      }),
    ).toBe('grossUp((line.net + IPI), 18/100)')
  })
})

describe('a component’s base, rate and amount', () => {
  it('rounds the base first, then taxes it, and explains every step', () => {
    const icms = evaluateComponent(
      expression({ grossUp: { base: { line: 'net' }, rate: rate('18', '100') } }),
      { numerator: 18n, denominator: 100n },
      line,
      none,
    )
    // 490000/41 = 11951.2… → 11951; × 18/100 = 2151.18 → 2151
    expect(icms).toMatchObject({ base: 11_951n, amount: 2_151n, outcome: 'levied' })
    expect(icms.steps.map((step) => step.step)).toEqual([
      'base = grossUp(line.net, 18/100)',
      'base, rounded half away from zero',
      'rate',
      'base × rate',
      'amount, rounded half away from zero',
    ])
  })

  it('keeps the base and owes nothing when the outcome is not levied', () => {
    for (const outcome of ['exempt', 'suspended', 'deferred', 'not-levied']) {
      const result = evaluateComponent(
        expression({ line: 'net' }, outcome),
        { numerator: 18n, denominator: 100n },
        line,
        none,
      )
      expect(result).toMatchObject({ base: 9_800n, amount: 0n, outcome })
    }
  })
})

describe('differences and deductions (Phase 85)', () => {
  const computed = new Map<string, bigint>([
    ['ICMS', 1_764n],
    ['IPI', 490n],
  ])

  it('takes the ICMS charged out of the revenue, for PIS/Cofins', () => {
    const pis = evaluateComponent(
      expression({ difference: [{ line: 'net' }, { component: 'ICMS' }] }),
      { numerator: 165n, denominator: 10_000n },
      line,
      computed,
    )
    // (9800 − 1764) × 1,65% = 132.594 → 133
    expect(pis).toMatchObject({ base: 8_036n, amount: 133n })
    expect(pis.steps[0]?.step).toBe('base = (line.net − ICMS)')
  })

  it('deducts the own-operation ICMS from the tax at the destination rate, never below zero', () => {
    const st = (deducted: bigint) =>
      evaluateComponent(
        ruleExpressionSchema.parse({
          version: FORMULA_VERSION,
          base: { product: [{ line: 'net' }, rate('14', '10')] },
          deduct: ['ICMS'],
        }),
        { numerator: 18n, denominator: 100n },
        line,
        new Map([['ICMS', deducted]]),
      )
    // 9800 × 1.4 = 13720; × 18% = 2469.6 → 2470; less 1176 → 1294
    const due = st(1_176n)
    expect(due).toMatchObject({ base: 13_720n, amount: 1_294n })
    expect(due.steps.slice(-2).map((step) => step.step)).toEqual([
      'less ICMS',
      'amount due, never below zero',
    ])
    expect(st(3_000n).amount).toBe(0n)
  })

  it('orders a deducting rule after what it deducts, and refuses an undefined deduction', () => {
    const icms = { code: 'ICMS', expression: expression({ line: 'net' }) }
    const st = {
      code: 'ICMS_ST',
      expression: ruleExpressionSchema.parse({
        version: FORMULA_VERSION,
        base: { line: 'net' },
        deduct: ['ICMS'],
      }),
    }
    const ordered = evaluationOrder([st, icms])
    expect('order' in ordered && ordered.order.map((rule) => rule.code)).toEqual([
      'ICMS',
      'ICMS_ST',
    ])
    expect(packageProblem([st])).toMatch(/reads component ICMS/)
  })
})

describe('the rounding a formula names', () => {
  it('rounds the base and the amount half to even when the formula says so', () => {
    const halfEven = ruleExpressionSchema.parse({
      version: FORMULA_VERSION,
      base: { line: 'net' },
      rounding: 'half-even',
    })
    const tie = lineValues({ gross: 50n, discount: 0n, charges: 0n, net: 50n, quantity: '1' })
    // 50 × 9/100 = 4.5: half to even gives 4, half away from zero 5.
    const even = evaluateComponent(halfEven, { numerator: 9n, denominator: 100n }, tie, none)
    const away = evaluateComponent(
      expression({ line: 'net' }),
      { numerator: 9n, denominator: 100n },
      tie,
      none,
    )
    expect(even).toMatchObject({ amount: 4n, rounding: 'half-even' })
    expect(away).toMatchObject({ amount: 5n, rounding: 'half-away-from-zero' })
    expect(even.steps.map((step) => step.step)).toContain('amount, rounded half to even')
  })

  it('refuses a rounding mode outside the vocabulary', () => {
    expect(
      ruleExpressionSchema.safeParse({
        version: FORMULA_VERSION,
        base: { line: 'net' },
        rounding: 'bankers',
      }).success,
    ).toBe(false)
  })
})

describe('components that read one another', () => {
  const rule = (code: string, base?: Expression) => ({
    code,
    ...(base ? { expression: expression(base) } : {}),
  })

  it('are evaluated after what they read, whatever order they come in', () => {
    const ordered = evaluationOrder([
      rule('ICMS', { sum: [{ line: 'net' }, { component: 'IPI' }] }),
      rule('FCP', { component: 'ICMS' }),
      rule('IPI', { line: 'net' }),
    ])
    expect('order' in ordered && ordered.order.map((entry) => entry.code)).toEqual([
      'IPI',
      'ICMS',
      'FCP',
    ])
    expect(evaluationOrder([rule('ICMS', { component: 'IPI' })])).toEqual({ missing: 'IPI' })
  })

  it('refuse a package with a cycle, a self-reference or an unknown component', () => {
    expect(packageProblem([rule('A', { component: 'B' }), rule('B', { component: 'A' })])).toMatch(
      /cycle/,
    )
    expect(packageProblem([rule('A', { component: 'A' })])).toMatch(/itself/)
    expect(packageProblem([rule('A', { component: 'X' })])).toMatch(/no rule of the package/)
    expect(packageProblem([rule('A', { component: 'B' }), rule('B')])).toBeNull()
  })
})

/** A small deterministic generator, so property tests need no dependency and never flake. */
function generator(seed: number) {
  let state = seed >>> 0
  return (limit: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state % limit
  }
}

describe('properties, over a thousand seeded cases', () => {
  const next = generator(83)
  const cases = Array.from({ length: 1_000 }, () => {
    const net = BigInt(next(10_000_000) - 1_000_000)
    return {
      values: lineValues({
        gross: net,
        discount: 0n,
        charges: 0n,
        net,
        quantity: String(next(50) + 1),
      }),
      rate: { numerator: BigInt(next(99) + 1), denominator: 100n },
    }
  })

  it('always give the same value for the same expression and line', () => {
    for (const { values, rate: r } of cases) {
      const base: Expression = {
        grossUp: {
          base: { line: 'net' },
          rate: { rate: { numerator: `${r.numerator}`, denominator: '100' } },
        },
      }
      expect(value(evaluate(base, values, none))).toBe(value(evaluate(base, values, none)))
    }
  })

  it('bring a grossed-up base back to the original, less its tax, within one minor unit', () => {
    for (const { values, rate: r } of cases) {
      const grossed = evaluate(
        {
          grossUp: {
            base: { line: 'net' },
            rate: { rate: { numerator: `${r.numerator}`, denominator: '100' } },
          },
        },
        values,
        none,
      )
      const rounded = roundHalfAwayFromZero(grossed)
      const tax = roundHalfAwayFromZero(multiply(integer(rounded), r))
      const back = rounded - tax
      const original = values.net.numerator
      expect(back - original <= 1n && original - back <= 1n).toBe(true)
    }
  })

  it('treat a reduction by zero and a product by one as identities', () => {
    for (const { values } of cases) {
      expect(
        value(evaluate({ reduce: { base: { line: 'net' }, by: rate('0', '1') } }, values, none)),
      ).toBe(value(values.net))
      expect(value(evaluate({ product: [{ line: 'net' }, rate('1', '1')] }, values, none))).toBe(
        value(values.net),
      )
    }
  })

  it('never produce anything but exact rationals', () => {
    for (const { values } of cases) {
      const result = evaluate({ product: [{ line: 'quantity' }, rate('7', '3')] }, values, none)
      expect(typeof result.numerator).toBe('bigint')
      expect(typeof result.denominator).toBe('bigint')
    }
  })
})

describe('whole documents', () => {
  const fixtureInput = async (): Promise<FiscalCalculationInput> =>
    JSON.parse(
      await readFile(
        new URL('../fixtures/rtc-v0057-model55-normal-sale-sp-2026-01.json', import.meta.url),
        'utf8',
      ),
    )

  it('give Phase 41’s approved bases, rates and amounts when its rules are expressions', async () => {
    const fixture = (await fixtureInput()) as unknown as {
      input: FiscalCalculationInput
      packageId: string
      ruleIds: Record<string, string>
    }
    const v1 = approvedPhase41ResolvedRules({
      packageId: fixture.packageId,
      cbsRuleId: fixture.ruleIds.CBS ?? '',
      ibsUfRuleId: fixture.ruleIds.IBS_UF ?? '',
      ibsMunRuleId: fixture.ruleIds.IBS_MUN ?? '',
    })
    const asExpressions: ResolvedRuleSet = {
      ...v1,
      explanationTemplateVersion: 'fiscal-explanation-v2',
      lines: Object.fromEntries(
        Object.entries(v1.lines).map(([lineId, rules]) => [
          lineId,
          rules.map((rule) => ({
            ...rule,
            formula: 'EXPRESSION' as const,
            expression: expression({ line: 'net' }),
          })),
        ]),
      ),
    }
    const before = calculateFiscal(fixture.input, v1)
    const after = calculateFiscal(fixture.input, asExpressions)
    if (!before.supported || !after.supported) throw new Error('both should be supported')
    const amounts = (result: typeof before) =>
      result.supported
        ? result.lines.flatMap((entry) =>
            entry.components.ibsCbs.map((component) => ({
              code: component.code,
              base: component.base,
              rate: component.rate,
              amount: component.amount,
            })),
          )
        : []
    expect(amounts(after)).toEqual(amounts(before))
    expect(after.totals).toEqual(before.totals)
    expect(after.resultDigest).not.toBe(before.resultDigest)
    expect(after.explanation.templateVersion).toBe('fiscal-explanation-v2')
  })

  it('tax a tax: ICMS over net plus IPI, grossed up, after IPI whatever the rule order', async () => {
    const { input } = (await fixtureInput()) as unknown as { input: FiscalCalculationInput }
    const [firstLine] = input.lines
    if (!firstLine) throw new Error('the fixture has a line')
    const source = {
      packageId: '00000000-0000-4000-8000-000000000083',
      digest: 'a'.repeat(64),
      uri: 'https://example.invalid/phase83',
      section: 'worked example',
      approved: true,
    }
    const component = (
      code: string,
      numerator: string,
      base: Expression,
      id: string,
    ): ResolvedComponentRule => ({
      group: 'legacy',
      code,
      rate: { numerator, denominator: '100' },
      formula: 'EXPRESSION',
      expression: expression(base),
      rule: { id, version: 1 },
      source,
    })
    const rules: ResolvedRuleSet = {
      schemaVersion: 1,
      currencyMinorUnitScale: 2,
      explanationTemplateVersion: 'fiscal-explanation-v2',
      lines: {
        [firstLine.id]: [
          component(
            'ICMS',
            '18',
            {
              grossUp: {
                base: { sum: [{ line: 'net' }, { component: 'IPI' }] },
                rate: rate('18', '100'),
              },
            },
            '00000000-0000-4000-8000-000000000001',
          ),
          component('IPI', '10', { line: 'net' }, '00000000-0000-4000-8000-000000000002'),
        ],
      },
    }
    const result = calculateFiscal(input, rules)
    if (!result.supported) throw new Error(JSON.stringify(result))
    const [calculated] = result.lines
    // net 10000 (BRL 100.00): IPI 1000; ICMS base (10000 + 1000) / 0.82 = 13414.63… → 13415;
    // ICMS 13415 × 18% = 2414.7 → 2415.
    expect(
      calculated?.components.legacy.map((entry) => [
        entry.code,
        entry.base.amount,
        entry.amount.amount,
      ]),
    ).toEqual([
      ['IPI', '10000', '1000'],
      ['ICMS', '13415', '2415'],
    ])
    expect(result.explanation.text).toContain('base = grossUp((line.net + IPI), 18/100)')
    expect(result.totals.legacyTax.amount).toBe('3415')
  })

  it('is unsupported when a formula reads a component the line does not select', async () => {
    const { input } = (await fixtureInput()) as unknown as { input: FiscalCalculationInput }
    const [firstLine] = input.lines
    if (!firstLine) throw new Error('the fixture has a line')
    const result = calculateFiscal(input, {
      schemaVersion: 1,
      currencyMinorUnitScale: 2,
      explanationTemplateVersion: 'fiscal-explanation-v2',
      lines: {
        [firstLine.id]: [
          {
            group: 'legacy',
            code: 'ICMS',
            rate: { numerator: '18', denominator: '100' },
            formula: 'EXPRESSION',
            expression: expression({ sum: [{ line: 'net' }, { component: 'IPI' }] }),
            rule: { id: '00000000-0000-4000-8000-000000000001', version: 1 },
            source: {
              packageId: '00000000-0000-4000-8000-000000000083',
              digest: 'a'.repeat(64),
              uri: 'https://example.invalid/phase83',
              section: 'worked example',
              approved: true,
            },
          },
        ],
      },
    })
    expect(result).toMatchObject({
      supported: false,
      code: 'UNSUPPORTED_RULE',
      missingDimension: 'component:IPI',
    })
  })
})
