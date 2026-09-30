import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packageProblem, ruleExpressionSchema } from './formula'
import {
  DECLARED_NCM,
  goodsPackage,
  issPackage,
  type SourceManifest,
  tipiRate,
} from './legacy-packages'
import { expectedResult, type Fixture, fixtureDigest, scenarios } from './legacy-scenarios'

const MANIFEST = join(__dirname, '..', '..', 'docs', 'tax-phase85-source-manifest.json')
const FIXTURES = join(__dirname, '..', 'fixtures', 'phase85')
const hasRepository = existsSync(MANIFEST)

async function packages() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as SourceManifest
  // The TIPI writes 8509.40.10 at 6.5%; reading the spreadsheet itself is checked where it is stored.
  return [
    goodsPackage(manifest, new Map([[DECLARED_NCM, '6.5']]), [DECLARED_NCM]),
    issPackage(manifest),
  ]
}

describe('the TIPI rate', () => {
  it('is an exact fraction of the percent written, without float noise', () => {
    expect(tipiRate('6.5')).toEqual({ numerator: '13', denominator: '200' })
    expect(tipiRate('7.8000000000000007')).toEqual({ numerator: '39', denominator: '500' })
    expect(tipiRate('0')).toEqual({ numerator: '0', denominator: '1' })
    expect(tipiRate('3.25')).toEqual({ numerator: '13', denominator: '400' })
  })
})

describe.skipIf(!hasRepository)('the legacy packages', () => {
  it('are well formed: every formula is known, every source fits the result', async () => {
    for (const pack of await packages()) {
      expect(packageProblem(pack.rules as never)).toBeNull()
      for (const rule of pack.rules) {
        expect(rule.sourceLocator.length).toBeLessThanOrEqual(200)
        if (rule.expression) ruleExpressionSchema.parse(rule.expression)
      }
    }
  })

  it('refuses an NCM the TIPI gives no rate for', async () => {
    const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as SourceManifest
    expect(() => goodsPackage(manifest, new Map([[DECLARED_NCM, 'NT']]), [DECLARED_NCM])).toThrow(
      /no ad valorem rate/,
    )
  })

  it('give an interstate sale to a non-contributor its own ICMS, DIFAL and FCP, each explained', async () => {
    const f5 = scenarios().find((scenario) => scenario.id.includes('f5'))
    if (!f5) throw new Error('F5 is declared')
    const result = expectedResult(f5, await packages())
    if (!result.supported) throw new Error(JSON.stringify(result))
    const components = Object.fromEntries(
      result.lines[0]?.components.legacy.map((component) => [component.code, component]) ?? [],
    )
    // 379,80 × 6,5% = 24,687 → 24,69; the ICMS base is 379,80 + 24,69 = 404,49.
    expect(components.IPI?.amount.amount).toBe('2469')
    expect(components.ICMS?.base.amount).toBe('40449')
    expect(components.ICMS?.amount.amount).toBe('4854')
    expect(components.ICMS_UF_DEST?.amount.amount).toBe('3236')
    expect(components.FCP_UF_DEST?.amount.amount).toBe('809')
    // PIS and Cofins over 379,80 − 48,54 = 331,26.
    expect(components.PIS?.base.amount).toBe('33126')
    expect([components.PIS?.amount.amount, components.COFINS?.amount.amount]).toEqual([
      '215',
      '994',
    ])
    expect(components.ICMS_UF_DEST?.steps?.[0]?.step).toBe('base = (line.net + IPI)')
    expect(components.ICMS_UF_DEST?.source.section).toMatch(/rj-lei-2657-1996: art\. 14 I/)
  })

  it("leave a commerce seller's sale to a non-contributor unsupported, naming the ICMS it cannot build", async () => {
    const f5 = scenarios().find((scenario) => scenario.id.includes('f5'))
    if (!f5) throw new Error('F5 is declared')
    const [line] = f5.input.lines
    if (!line) throw new Error('F5 has a line')
    const commerce = { ...f5, input: { ...f5.input, lines: [{ ...line, taxFacts: {} }] } }
    expect(expectedResult(commerce, await packages())).toMatchObject({
      supported: false,
      missingDimension: 'component:ICMS',
    })
  })

  it('match the fixtures on disk, whose approvals sign exactly what they approved', async () => {
    const built = await packages()
    const names = (await readdir(FIXTURES)).filter((name) => name.endsWith('.json'))
    expect(names).toHaveLength(scenarios().length)
    for (const scenario of scenarios()) {
      const fixture = JSON.parse(
        await readFile(join(FIXTURES, `${scenario.id}.json`), 'utf8'),
      ) as Fixture
      expect(fixture.expectedResult).toEqual(
        JSON.parse(JSON.stringify(expectedResult(scenario, built))),
      )
      expect(fixture.input).toEqual(JSON.parse(JSON.stringify(scenario.input)))
      if (fixture.approval) {
        const { approval, ...unsigned } = fixture
        expect(approval.fixtureDigest).toBe(fixtureDigest(unsigned))
      }
    }
  })
})
