import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { calculateFiscal } from './calculation'
import { packageProblem, ruleExpressionSchema } from './formula'
import {
  DECLARED_NCM,
  goodsPackage,
  issPackage,
  publicationAsTaxRules,
  type SourceManifest,
} from './legacy-packages'
import { expectedResult, type Fixture, fixtureDigest } from './legacy-scenarios'
import { BLEND, blendPackage, pisCofinsNormalPackage, simplesMeiPackage } from './regime-packages'
import { regimeScenarios } from './regime-scenarios'
import { resolveTaxRules, type TaxRule } from './rules'

const DOCS = join(__dirname, '..', '..', 'docs')
const FIXTURES = join(__dirname, '..', 'fixtures', 'phase86')
const hasRepository = existsSync(join(DOCS, 'tax-phase86-source-manifest.json'))

async function manifest(): Promise<SourceManifest> {
  const sources = await Promise.all(
    ['82', '85', '86'].map(
      async (phase) =>
        (
          JSON.parse(
            await readFile(join(DOCS, `tax-phase${phase}-source-manifest.json`), 'utf8'),
          ) as SourceManifest
        ).sources,
    ),
  )
  return { sources: sources.flat() }
}

async function packages() {
  const sources = await manifest()
  return [
    goodsPackage(sources, new Map([[DECLARED_NCM, '6.5']]), [DECLARED_NCM]),
    issPackage(sources),
    pisCofinsNormalPackage(sources),
    simplesMeiPackage(sources),
    blendPackage(sources),
  ]
}

const scenario = (fragment: string) => {
  const found = regimeScenarios().find((candidate) => candidate.id.includes(fragment))
  if (!found) throw new Error(`${fragment} is declared`)
  return found
}

const components = (result: ReturnType<typeof expectedResult>) => {
  if (!result.supported) throw new Error(JSON.stringify(result))
  const line = result.lines[0]
  return Object.fromEntries(
    [...(line?.components.legacy ?? []), ...(line?.components.ibsCbs ?? [])].map((component) => [
      component.code,
      component,
    ]),
  )
}

describe.skipIf(!hasRepository)('the regime packages', () => {
  it('are well formed, and PIS/Cofins names the ICMS it reads from Phase 85', async () => {
    for (const pack of (await packages()).slice(2)) {
      expect(packageProblem(pack.rules as never, pack.requires ?? [])).toBeNull()
      for (const rule of pack.rules) {
        expect(rule.sourceLocator.length).toBeLessThanOrEqual(200)
        if (rule.expression) ruleExpressionSchema.parse(rule.expression)
      }
    }
    const [, , pisCofins] = await packages()
    expect(pisCofins?.requires).toEqual(['ICMS'])
    expect(packageProblem(pisCofins?.rules as never)).toMatch(/reads component ICMS/)
  })

  it('give a Simples and an MEI issuer none of the taxes the DAS collects, each explained', async () => {
    for (const fragment of ['g1', 'g2']) {
      const found = components(expectedResult(scenario(fragment), await packages()))
      expect(Object.keys(found).sort()).toEqual(
        ['CBS', 'COFINS', 'IBS_MUN', 'IBS_UF', 'ICMS', 'PIS'].sort(),
      )
      for (const component of Object.values(found)) {
        expect(component.outcome).toBe('not-levied')
        expect(component.amount.amount).toBe('0')
      }
      expect(found.ICMS?.source.section).toMatch(/lc-123-2006: art\. (13|18-A)/)
      expect(found.CBS?.source.section).toMatch(/lc-214-2025: art\. 348 III c/)
    }
  })

  it('give a Presumido and a Real issuer their own PIS/Cofins method over the same ICMS', async () => {
    const presumido = components(expectedResult(scenario('g3'), await packages()))
    const real = components(expectedResult(scenario('g4'), await packages()))
    expect([presumido.ICMS?.amount.amount, real.ICMS?.amount.amount]).toEqual(['6836', '6836'])
    // 311,44 × 0,65% = 2,02 and × 3% = 9,34; × 1,65% = 5,14 and × 7,6% = 23,67.
    expect([presumido.PIS?.amount.amount, presumido.COFINS?.amount.amount]).toEqual(['202', '934'])
    expect([real.PIS?.amount.amount, real.COFINS?.amount.amount]).toEqual(['514', '2367'])
  })

  it('scale the ICMS and ISS rates by the year of the blend, leaving FCP out', async () => {
    const [, , , , blend] = await packages()
    const rates = new Map(
      blend?.rules.map((rule) => [rule.ruleKey, `${rule.rate.numerator}/${rule.rate.denominator}`]),
    )
    // 18% × 9/10, 8/10, 7/10, 6/10.
    expect(
      BLEND.map((share) => rates.get(`phase86.blend.${share.year}.icms.sp-sp.contributor-resale`)),
    ).toEqual(['81/500', '18/125', '63/500', '27/250'])
    expect(rates.get('phase86.blend.2030.iss.3550308.010101')).toBe('29/1250')
    expect(blend?.rules.some((rule) => rule.code === 'FCP_UF_DEST')).toBe(false)
  })

  it('show a 2030 document ICMS at 8/10 of its rate beside a hypothetical IBS, citing both', async () => {
    const g6 = scenario('g6')
    const hypothetical: TaxRule = {
      tenantId: g6.input.tenantId,
      group: 'ibsCbs',
      code: 'IBS_UF',
      precedence: 'default',
      priority: 100,
      dateBasis: 'issue_date',
      effectiveFrom: '2030-01-01',
      effectiveTo: '2031-01-01',
      active: true,
      scope: { model: '55', environment: 'simulation', purpose: 'normal' },
      rate: { numerator: '1', denominator: '10' },
      formula: 'EXPRESSION',
      expression: ruleExpressionSchema.parse({ version: 'formula-v1', base: { line: 'net' } }),
      rule: { id: '018f5d4e-1000-7000-8000-000000000086', version: 1 },
      source: {
        packageId: '018f5d4e-1000-7000-8000-000000000087',
        digest: '0'.repeat(64),
        uri: 'https://example.invalid/hypothetical',
        section: 'hypothetical IBS UF rate of 10% for 2030, never published',
        approved: true,
      },
    }
    const rules = [
      ...(await packages()).flatMap((pack) => publicationAsTaxRules(pack, g6.input.tenantId)),
      hypothetical,
    ]
    const resolution = resolveTaxRules(g6.input, rules, 2)
    if (!resolution.supported) throw new Error(JSON.stringify(resolution))
    const found = components(calculateFiscal(g6.input, resolution.rules))
    expect(found.ICMS?.amount.amount).toBe('5469')
    expect(found.ICMS?.source.section).toMatch(/ec-132-2023: ADCT art\. 128 \(8\/10 in 2030\)/)
    expect(found.IBS_UF?.amount.amount).toBe('3798')
    expect(found.IBS_UF?.source.section).toMatch(/hypothetical/)
  })

  it('follow the regime a Simples exclusion on 1 July gives each day', async () => {
    const june = components(expectedResult(scenario('g7a'), await packages()))
    const july = components(expectedResult(scenario('g7b'), await packages()))
    expect(june.ICMS?.outcome).toBe('not-levied')
    expect(july.ICMS?.amount.amount).toBe('6836')
    expect(july.PIS?.amount.amount).toBe('202')
  })

  it('match the fixtures on disk, whose approvals sign exactly what they approved', async () => {
    const built = await packages()
    const names = (await readdir(FIXTURES)).filter((name) => name.endsWith('.json'))
    expect(names).toHaveLength(regimeScenarios().length)
    for (const declared of regimeScenarios()) {
      const fixture = JSON.parse(
        await readFile(join(FIXTURES, `${declared.id}.json`), 'utf8'),
      ) as Fixture
      expect(fixture.expectedResult).toEqual(
        JSON.parse(JSON.stringify(expectedResult(declared, built))),
      )
      expect(fixture.input).toEqual(JSON.parse(JSON.stringify(declared.input)))
      if (fixture.approval) {
        const { approval, ...unsigned } = fixture
        expect(approval.fixtureDigest).toBe(fixtureDigest(unsigned))
      }
    }
  })
})
