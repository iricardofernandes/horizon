import { ruleExpressionSchema } from './formula'
import {
  type Entry,
  FACTS,
  icmsPart,
  issRules,
  publication,
  type Rule,
  type SourceManifest,
  source,
} from './legacy-packages'

/**
 * The regime packages of Phase 86 (ADR 0072): PIS/Cofins by a normal issuer's income-tax
 * regime; what a Simples or MEI issuer's document carries (none of the taxes the DAS
 * collects); and the 2029–2032 blend of ICMS and ISS. Rates and fractions are read from
 * pinned sources (docs/tax-phase85-source-manifest.json and tax-phase86-source-manifest.json).
 */

const PUBLISHER = 'platform:phase86'
const FROM = '2026-01-01'
const UNTIL_REFORM = '2027-01-01'
/** ICMS and ISS end in 2033 (EC 132 ADCT art. 129); until then a Simples issuer pays them in the DAS. */
const UNTIL_END = '2033-01-01'
/** Above every tax rule of Phases 41 to 85, so a Simples or MEI issuer's answer wins. */
const REGIME_PRIORITY = 200

const expression = (base: unknown, extra: Record<string, unknown> = {}) =>
  ruleExpressionSchema.parse({ version: 'formula-v1', base, ...extra })
const NET = { line: 'net' }

function rule(fields: Omit<Rule, 'version' | 'precedence' | 'environment' | 'formula'>): Rule {
  return {
    version: 1,
    precedence: 'default',
    environment: 'simulation',
    formula: 'EXPRESSION',
    ...fields,
  }
}

/** PIS/Cofins for a normal issuer, by its income-tax regime, over the revenue less its ICMS. */
export function pisCofinsNormalPackage(manifest: SourceManifest) {
  const revenue = { difference: [{ line: 'net' }, { component: 'ICMS' }] }
  const exclusions = 'pgfn-parecer-7698-2021; dl-1598-1977: art. 12 §4º'
  const methods = [
    {
      regime: 'lucro-real' as const,
      pis: { numerator: '33', denominator: '2000' },
      cofins: { numerator: '19', denominator: '250' },
      pisAt: 'lei-10637-2002: art. 2º (1,65%)',
      cofinsAt: 'lei-10833-2003: art. 2º (7,6%)',
    },
    {
      regime: 'lucro-presumido' as const,
      pis: { numerator: '13', denominator: '2000' },
      cofins: { numerator: '3', denominator: '100' },
      pisAt: 'lei-9715-1998: art. 8º I (0,65%); lei-10637-2002: art. 8º II',
      cofinsAt: 'lei-9718-1998: art. 8º (3%); lei-10833-2003: art. 10 II',
    },
  ]
  const rules = methods.flatMap((method) =>
    (['PIS', 'COFINS'] as const).map((code) =>
      rule({
        ruleKey: `phase86.${code.toLowerCase()}.normal.${method.regime}`,
        group: 'legacy',
        code,
        priority: 100,
        model: '55',
        issuerRegime: 'normal',
        issuerIncomeTaxRegime: method.regime,
        // As the declared ICMS scenarios, a contributor buying to resell.
        fact: { key: FACTS.destinationUse, value: 'resale' },
        effectiveFrom: FROM,
        effectiveTo: UNTIL_REFORM,
        rate: code === 'PIS' ? method.pis : method.cofins,
        expression: expression(revenue),
        sourceLocator: `${code === 'PIS' ? method.pisAt : method.cofinsAt}; ${exclusions}`,
      }),
    ),
  )
  const sources = [
    'lei-10637-2002',
    'lei-10833-2003',
    'lei-9715-1998',
    'lei-9718-1998',
    'dl-1598-1977',
    'pgfn-parecer-7698-2021',
  ]
  return publication(
    'phase86.pis-cofins.normal.2026',
    'Horizon — PIS/Cofins by a normal issuer’s income-tax regime (Phase 86)',
    source(manifest, 'lei-10833-2003').uri,
    sources.map((id) => source(manifest, id)),
    rules,
    [],
    { requires: ['ICMS'], publisher: PUBLISHER },
  )
}

/**
 * A Simples or MEI issuer's document: the taxes the DAS collects are not levied on it (LC 123
 * arts. 13 and 18-A), and in 2026 neither are IBS and CBS (LC 214 art. 348 III c).
 */
export function simplesMeiPackage(manifest: SourceManifest) {
  const regimes = [
    { regime: 'simples-nacional', at: 'lc-123-2006: art. 13' },
    { regime: 'mei', at: 'lc-123-2006: art. 18-A' },
  ]
  const zero = { numerator: '0', denominator: '1' }
  const notLevied = expression(NET, { outcome: 'not-levied' })
  const rules: Rule[] = regimes.flatMap(({ regime, at }) => [
    ...(['ICMS', 'PIS', 'COFINS'] as const).map((code) =>
      rule({
        ruleKey: `phase86.${regime}.${code.toLowerCase()}`,
        group: 'legacy',
        code,
        priority: REGIME_PRIORITY,
        model: '55',
        issuerRegime: regime,
        effectiveFrom: FROM,
        effectiveTo: code === 'ICMS' ? UNTIL_END : UNTIL_REFORM,
        rate: zero,
        expression: notLevied,
        sourceLocator: `${at} (collected in the DAS, not on the document)`,
      }),
    ),
    rule({
      ruleKey: `phase86.${regime}.ipi`,
      group: 'legacy',
      code: 'IPI',
      priority: REGIME_PRIORITY,
      model: '55',
      issuerRegime: regime,
      fact: { key: FACTS.ipiTaxpayer, value: 'true' },
      effectiveFrom: FROM,
      effectiveTo: UNTIL_REFORM,
      rate: zero,
      expression: notLevied,
      sourceLocator: `${at}, II (IPI collected in the DAS)`,
    }),
    rule({
      ruleKey: `phase86.${regime}.iss`,
      group: 'legacy',
      code: 'ISS',
      priority: REGIME_PRIORITY,
      model: 'nfse',
      issuerRegime: regime,
      effectiveFrom: FROM,
      effectiveTo: UNTIL_END,
      rate: zero,
      expression: notLevied,
      sourceLocator: `${at} (ISS collected in the DAS)`,
    }),
    ...(['55', '65'] as const).flatMap((model) =>
      (['CBS', 'IBS_UF', 'IBS_MUN'] as const).map((code) =>
        rule({
          ruleKey: `phase86.${regime}.${code.toLowerCase()}.m${model}`,
          group: 'ibsCbs',
          code,
          priority: REGIME_PRIORITY,
          model,
          issuerRegime: regime,
          effectiveFrom: FROM,
          effectiveTo: UNTIL_REFORM,
          rate: zero,
          expression: notLevied,
          sourceLocator:
            'lc-214-2025: art. 348 III c (the 2026 rates do not apply to Simples optants)',
        }),
      ),
    ),
  ])
  // A classified line needs its classification's reference, as in Phase 84.
  const entries: Entry[] = [
    {
      family: 'class_trib',
      code: '000001',
      description: 'Situações tributadas integralmente pelo IBS e CBS.',
      model: '*',
      jurisdiction: 'BR',
      effectiveFrom: FROM,
      effectiveTo: UNTIL_REFORM,
      sourceLocator: 'calculadora-pro.db (V0059): CLASSIFICACAO_TRIBUTARIA 000001',
    },
  ]
  return publication(
    'phase86.simples-mei',
    'Horizon — what a Simples Nacional or MEI issuer’s document carries (Phase 86)',
    source(manifest, 'lc-123-2006').uri,
    ['lc-123-2006', 'lc-214-2025'].map((id) => source(manifest, id)),
    rules,
    entries,
    { publisher: PUBLISHER },
  )
}

/** EC 132 ADCT art. 128: the share of each year's ICMS and ISS rates. */
export const BLEND = [
  { year: 2029, numerator: 9n, denominator: 10n },
  { year: 2030, numerator: 8n, denominator: 10n },
  { year: 2031, numerator: 7n, denominator: 10n },
  { year: 2032, numerator: 6n, denominator: 10n },
] as const

function scaled(rate: { numerator: string; denominator: string }, share: (typeof BLEND)[number]) {
  const numerator = BigInt(rate.numerator) * share.numerator
  const denominator = BigInt(rate.denominator) * share.denominator
  const divisor = gcd(numerator, denominator)
  return { numerator: String(numerator / divisor), denominator: String(denominator / divisor) }
}

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b)
}

/**
 * The Phase 85 ICMS and ISS rules, once a year from 2029 to 2032, at that year's share of their
 * rate. FCP is left out: whether the fund's additional shrinks with the rate is not settled by
 * the sources pinned. IPI is zero from 2027, so no base adds it.
 */
export function blendPackage(manifest: SourceManifest) {
  const phase85 = [...icmsPart().rules, ...issRules()].filter((base) => base.code !== 'FCP_UF_DEST')
  const rules: Rule[] = BLEND.flatMap((share) =>
    phase85.map((base) => ({
      ...base,
      ruleKey: `phase86.blend.${share.year}.${base.ruleKey}`,
      effectiveFrom: `${share.year}-01-01`,
      effectiveTo: `${share.year + 1}-01-01`,
      rate: scaled(base.rate, share),
      expression: expression(NET),
      sourceLocator:
        `ec-132-2023: ADCT art. 128 (${share.numerator}/${share.denominator} in ${share.year}) of ${base.sourceLocator}`.slice(
          0,
          200,
        ),
    })),
  )
  return publication(
    'phase86.blend.2029-2032',
    'Horizon — the ICMS and ISS rates of 2029 to 2032, as EC 132 fixes their share (Phase 86)',
    source(manifest, 'ec-132-2023').uri,
    [
      'ec-132-2023',
      'ricms-sp-art-52',
      'rj-lei-2657-1996',
      'conv-icms-236-2021',
      'sp-lei-13701-2003',
    ].map((id) => source(manifest, id)),
    rules,
    [],
    { publisher: PUBLISHER },
  )
}
