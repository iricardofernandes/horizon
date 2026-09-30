import { describe, expect, it } from 'vitest'
import { packageProblem } from './formula'
import {
  buildRtcPackage,
  type CalculatorClass,
  effectiveRate,
  inForce,
  MODELLED_TREATMENTS,
  modelled,
} from './rtc-package'

const window = { effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' }
const rates = { CBS: '0.9', IBSUF: '0.1', IBSMun: '0' }

function klass(overrides: Partial<CalculatorClass> = {}): CalculatorClass {
  return {
    code: '000001',
    description: 'Situações tributadas integralmente pelo IBS e CBS.',
    situation: '000',
    treatmentId: 3,
    treatment: 'Tributação integral',
    startsOn: '2026-01-01',
    endsOn: null,
    documentModels: ['55', '65'],
    reductions: { CBS: '0', IBSUF: '0', IBSMun: '0' },
    ...overrides,
  }
}

const build = (classes: CalculatorClass[]) =>
  buildRtcPackage({ label: 'rtc.test', classes, ncms: [], rates, window })

describe('the effective rate', () => {
  it('is the reference rate less the reduction, as an exact fraction', () => {
    // 0,9% × (1 − 60%) = 0,36%, CBS 3,60 over 1.000,00 in the calculator.
    expect(effectiveRate('0.9', '60')).toEqual({ numerator: '9', denominator: '2500' })
    expect(effectiveRate('0.9', '0')).toEqual({ numerator: '9', denominator: '1000' })
    expect(effectiveRate('0.9', '100')).toEqual({ numerator: '0', denominator: '1' })
    expect(effectiveRate('0.1', '30')).toEqual({ numerator: '7', denominator: '10000' })
  })
})

describe('which classes are modelled', () => {
  it('names why a class is left out', () => {
    expect(modelled(klass(), window)).toBeNull()
    expect(modelled(klass({ treatmentId: 22, treatment: 'Suspensão' }), window)).toMatch(
      /treatment 22/,
    )
    expect(modelled(klass({ documentModels: ['NFSe'] }), window)).toBe(
      'not applicable to NF-e or NFC-e',
    )
    expect(modelled(klass({ startsOn: '2027-01-01' }), window)).toBe('not in force in the window')
    expect(modelled(klass({ endsOn: '2026-01-01' }), window)).toBe('withdrawn')
  })

  it('leaves suspension out, since the calculator needs the regular taxation it suspends', () => {
    expect(MODELLED_TREATMENTS[22]).toBeUndefined()
  })
})

describe('the package built from the calculator', () => {
  it('gives each class CBS, IBS UF and IBS Mun per model, rounded half to even', () => {
    const built = build([
      klass({ code: '200032', reductions: { CBS: '60', IBSUF: '60', IBSMun: '60' } }),
    ])
    expect(built.rules).toHaveLength(6)
    expect(built.rules.map((rule) => `${rule.code}.m${rule.model}`).sort()).toEqual([
      'CBS.m55',
      'CBS.m65',
      'IBS_MUN.m55',
      'IBS_MUN.m65',
      'IBS_UF.m55',
      'IBS_UF.m65',
    ])
    const cbs = built.rules.find((rule) => rule.code === 'CBS' && rule.model === '55')
    expect(cbs).toMatchObject({
      precedence: 'default',
      environment: 'simulation',
      classification: { kind: 'class_trib', code: '200032' },
      effectiveFrom: '2026-01-01',
      effectiveTo: '2027-01-01',
      rate: { numerator: '9', denominator: '2500' },
      formula: 'EXPRESSION',
      expression: { base: { line: 'net' }, outcome: 'levied', rounding: 'half-even' },
    })
    expect(cbs?.sourceLocator).toContain('reduction 60%')
    expect(built.entries).toContainEqual(
      expect.objectContaining({ family: 'class_trib', code: '200032' }),
    )
    expect(packageProblem(built.rules as never)).toBeNull()
  })

  it('maps each treatment to its outcome', () => {
    const outcomes = Object.fromEntries(
      [
        ['410001', 18],
        ['410002', 19],
        ['000001', 3],
      ].map(([code, treatmentId]) => {
        const built = build([klass({ code: String(code), treatmentId: Number(treatmentId) })])
        return [code, built.rules[0]?.expression.outcome]
      }),
    )
    expect(outcomes).toEqual({ '410001': 'exempt', '410002': 'not-levied', '000001': 'levied' })
  })

  it('writes base exclusion as a reduction of the base, as the calculator does', () => {
    const half = build([klass({ code: '200001', treatmentId: 17 })]).rules[0]
    const whole = build([klass({ code: '200002', treatmentId: 40 })]).rules[0]
    expect(half?.expression.base).toEqual({
      reduce: { base: { line: 'net' }, by: { rate: { numerator: '1', denominator: '2' } } },
    })
    expect(whole?.expression.base).toEqual({
      reduce: { base: { line: 'net' }, by: { rate: { numerator: '1', denominator: '1' } } },
    })
  })

  it('records every excluded class with its reason and is the same on every build', () => {
    const classes = [klass(), klass({ code: '550001', treatmentId: 22, treatment: 'Suspensão' })]
    const first = build(classes)
    expect(first.excluded).toEqual([
      { code: '550001', why: 'treatment 22 (Suspensão) is not modelled' },
    ])
    expect(JSON.stringify(build([...classes].reverse()))).toBe(JSON.stringify(first))
  })
})

describe('validity', () => {
  it('holds from the first day through the last one the calculator stores', () => {
    const row = { startsOn: '2026-01-01', endsOn: '2026-12-31' }
    expect(inForce(row, '2026-01-01')).toBe(true)
    expect(inForce(row, '2026-12-31')).toBe(true)
    expect(inForce(row, '2027-01-01')).toBe(false)
    expect(inForce({ startsOn: '2026-01-01', endsOn: null }, '2033-01-01')).toBe(true)
  })
})
