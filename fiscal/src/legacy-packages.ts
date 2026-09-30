import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { canonicalDigest } from './canonical-json'
import type { CatalogPublication } from './catalog'
import { ruleExpressionSchema } from './formula'
import { deterministicUuid, type referenceEntrySchema, type taxRuleImportSchema } from './rule-rows'
import type { TaxRule } from './rules'

/**
 * The legacy-tax packages of Phase 85 (ADR 0072): ICMS for São Paulo as the issuer and Rio de
 * Janeiro and Bahia as destinations, IPI from the TIPI, PIS/Cofins by the seller's regime and
 * ISS for São Paulo. Every rate is read from a pinned source (docs/tax-phase85-source-manifest.json);
 * a scenario is supported only once its fixture is approved.
 */

type Rule = z.input<typeof taxRuleImportSchema>
type Entry = z.infer<typeof referenceEntrySchema>

export const SAO_PAULO = '35'
export const RIO_DE_JANEIRO = '33'
export const BAHIA = '29'
export const SAO_PAULO_CITY = '3550308'
/** Liquidificadores (TIPI 8509.40.10): no special ICMS rate in SP (RICMS arts. 53-A to 56) or RJ. */
export const DECLARED_NCM = '85094010'
/** LC 116 subitem 1.01, análise e desenvolvimento de sistemas, as the national NFS-e codes it. */
export const DECLARED_SERVICE = '010101'

/** The facts a line states, which rules read (Phase 85). */
export const FACTS = {
  /** The issuer is an IPI taxpayer for the item: an industrial establishment or one equated to it. */
  ipiTaxpayer: 'ipiTaxpayer',
  /** What a contributor recipient does with the goods; only resale is declared. */
  destinationUse: 'destinationUse',
} as const

/** ICMS and ISS change from 2029 (EC 132 ADCT art. 128); PIS/Cofins and IPI from 2027 (art. 126). */
const UNTIL_BLEND = '2029-01-01'
const UNTIL_REFORM = '2027-01-01'
const FROM = '2026-01-01'

const rate = (numerator: string, denominator: string) => ({ numerator, denominator })
const expression = (base: unknown, extra: Record<string, unknown> = {}) =>
  ruleExpressionSchema.parse({ version: 'formula-v1', base, ...extra })
const NET = { line: 'net' }
const NET_PLUS_IPI = { sum: [{ line: 'net' }, { component: 'IPI' }] }

function goodsRule(
  rule: Omit<
    Rule,
    'group' | 'precedence' | 'model' | 'environment' | 'formula' | 'version' | 'effectiveFrom'
  > & { effectiveFrom?: string },
): Rule {
  return {
    version: 1,
    group: 'legacy',
    precedence: 'default',
    model: '55',
    environment: 'simulation',
    effectiveFrom: FROM,
    formula: 'EXPRESSION',
    ...rule,
  }
}

/** A published package, named by its manifest: the sources it reads and its own content. */
function publication(
  label: string,
  authority: string,
  sourceUri: string,
  sources: readonly { id: string; sha256: string }[],
  rules: Rule[],
  entries: Entry[],
): CatalogPublication & { label: string } {
  const manifest = {
    label,
    sources: sources.map((source) => ({ id: source.id, sha256: source.sha256 })),
    contentDigest: canonicalDigest({ entries, rules }),
  }
  return {
    label,
    authority,
    sourceUri,
    publishedAt: '2026-09-30',
    effectiveFrom: FROM,
    publisher: 'platform:phase85',
    entries,
    rules: rules as CatalogPublication['rules'],
    bytes: Buffer.from(JSON.stringify(manifest)),
  }
}

export type SourceManifest = {
  sources: { id: string; uri: string; sha256: string }[]
}

const source = (manifest: SourceManifest, id: string) => {
  const found = manifest.sources.find((entry) => entry.id === id)
  if (!found) throw new Error(`the source manifest has no ${id}`)
  return found
}

/** ICMS: SP's internal and interstate rates, RJ's internal rate and FECP for DIFAL. */
function icmsPart() {
  const contributorResale = {
    recipientTaxpayer: true,
    fact: { key: FACTS.destinationUse, value: 'resale' },
  }
  const nonContributor = {
    recipientTaxpayer: false,
    fact: { key: FACTS.ipiTaxpayer, value: 'true' },
  }
  const rules: Rule[] = [
    goodsRule({
      ruleKey: 'icms.sp-sp.contributor-resale',
      code: 'ICMS',
      priority: 100,
      originState: SAO_PAULO,
      destinationState: SAO_PAULO,
      ...contributorResale,
      effectiveTo: UNTIL_BLEND,
      rate: rate('18', '100'),
      expression: expression(NET),
      sourceLocator:
        'ricms-sp-art-52: art. 52 I (18%); lc-87-1996: art. 13 I, §1º I, §2º (IPI outside the base for resale)',
    }),
    goodsRule({
      ruleKey: 'icms.sp-rj.contributor-resale',
      code: 'ICMS',
      priority: 100,
      originState: SAO_PAULO,
      destinationState: RIO_DE_JANEIRO,
      ...contributorResale,
      effectiveTo: UNTIL_BLEND,
      rate: rate('12', '100'),
      expression: expression(NET),
      sourceLocator: 'ricms-sp-art-52: art. 52 III (12% to S and SE); lc-87-1996: art. 13 §2º',
    }),
    goodsRule({
      ruleKey: 'icms.sp-ba.contributor-resale',
      code: 'ICMS',
      priority: 100,
      originState: SAO_PAULO,
      destinationState: BAHIA,
      ...contributorResale,
      effectiveTo: UNTIL_BLEND,
      rate: rate('7', '100'),
      expression: expression(NET),
      sourceLocator:
        'ricms-sp-art-52: art. 52 II (7% to N, NE, CO and ES); lc-87-1996: art. 13 §2º',
    }),
    goodsRule({
      ruleKey: 'icms.sp-rj.contributor-resale.imported',
      code: 'ICMS',
      // Above the 12% rule it replaces for goods imported directly (NF-e origin 1).
      priority: 110,
      originState: SAO_PAULO,
      destinationState: RIO_DE_JANEIRO,
      ...contributorResale,
      classification: { kind: 'origin', code: '1' },
      effectiveTo: UNTIL_BLEND,
      rate: rate('4', '100'),
      expression: expression(NET),
      sourceLocator: 'ricms-sp-art-52: art. 52 §2º (4% for imported goods, Res. SF 13/2012)',
    }),
    goodsRule({
      ruleKey: 'icms.sp-rj.non-contributor',
      code: 'ICMS',
      priority: 100,
      originState: SAO_PAULO,
      destinationState: RIO_DE_JANEIRO,
      ...nonContributor,
      effectiveTo: UNTIL_BLEND,
      rate: rate('12', '100'),
      expression: expression(NET_PLUS_IPI),
      sourceLocator:
        'conv-icms-236-2021: cl. 2ª I b (the interstate rate for the origin); lc-87-1996: art. 13 X, §1º I; IPI in the base, art. 13 §2º a contrario',
    }),
    goodsRule({
      ruleKey: 'icms-uf-dest.rj.non-contributor',
      code: 'ICMS_UF_DEST',
      priority: 100,
      originState: SAO_PAULO,
      destinationState: RIO_DE_JANEIRO,
      ...nonContributor,
      effectiveTo: UNTIL_BLEND,
      rate: rate('8', '100'),
      expression: expression(NET_PLUS_IPI),
      sourceLocator:
        'rj-lei-2657-1996: art. 14 I (20%) and V; conv-icms-236-2021: cl. 2ª I c, §1º (base única); lc-87-1996: art. 13 §3º (20% − 12%)',
    }),
    goodsRule({
      ruleKey: 'fcp-uf-dest.rj.non-contributor',
      code: 'FCP_UF_DEST',
      priority: 100,
      originState: SAO_PAULO,
      destinationState: RIO_DE_JANEIRO,
      ...nonContributor,
      effectiveTo: UNTIL_BLEND,
      rate: rate('2', '100'),
      expression: expression(NET_PLUS_IPI),
      sourceLocator: 'rj-lc-210-2023: art. 2º I (2 p.p.); conv-icms-236-2021: cl. 2ª §4º',
    }),
  ]
  const entries: Entry[] = [
    {
      family: 'ncm',
      code: DECLARED_NCM,
      description: 'Liquidificadores',
      model: '*',
      jurisdiction: 'BR',
      effectiveFrom: FROM,
      sourceLocator: 'tipi-2022: 8509.40.10',
    },
  ]
  const sources = [
    'lc-87-1996',
    'conv-icms-236-2021',
    'ricms-sp-art-52',
    'rj-lei-2657-1996',
    'rj-lc-210-2023',
  ]
  return { rules, entries, sources }
}

/** A TIPI rate, as the spreadsheet stores it (a decimal percent, sometimes with float noise). */
export function tipiRate(percent: string): { numerator: string; denominator: string } {
  const fixed = Number(percent).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  const [whole, fraction = ''] = fixed.split('.')
  const numerator = BigInt(`${whole}${fraction}`)
  const denominator = 100n * 10n ** BigInt(fraction.length)
  const divisor = gcd(numerator, denominator)
  return {
    numerator: String(numerator / divisor),
    denominator: String(denominator / divisor),
  }
}

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b)
}

/** IPI for the declared NCMs, at the TIPI's rate, when the issuer is an IPI taxpayer. */
function ipiPart(tipi: ReadonlyMap<string, string>, ncms: readonly string[]) {
  const rules: Rule[] = ncms.map((ncm) => {
    const percent = tipi.get(ncm)
    if (percent === undefined || !/^\d/.test(percent))
      throw new Error(`the TIPI gives no ad valorem rate for ${ncm}`)
    return goodsRule({
      ruleKey: `ipi.${ncm}`,
      code: 'IPI',
      priority: 100,
      classification: { kind: 'ncm', code: ncm },
      fact: { key: FACTS.ipiTaxpayer, value: 'true' },
      effectiveTo: UNTIL_REFORM,
      rate: tipiRate(percent),
      expression: expression(NET),
      sourceLocator: `tipi-2022: ${ncm.slice(0, 4)}.${ncm.slice(4, 6)}.${ncm.slice(6)} (${percent}%)`,
    })
  })
  return { rules, entries: [] as Entry[], sources: ['tipi-2022'] }
}

/** PIS and Cofins by the seller's regime, over the revenue less the ICMS charged on it. */
function pisCofinsPart() {
  const revenue = { difference: [{ line: 'net' }, { component: 'ICMS' }] }
  const exclusions =
    'pgfn-parecer-7698-2021 (the ICMS charged is excluded); dl-1598-1977: art. 12 §4º (IPI outside the revenue)'
  const methods = [
    {
      regime: 'lucro-real',
      pis: rate('33', '2000'),
      cofins: rate('19', '250'),
      pisAt: 'lei-10637-2002: art. 2º (1,65%)',
      cofinsAt: 'lei-10833-2003: art. 2º (7,6%)',
    },
    {
      regime: 'lucro-presumido',
      pis: rate('13', '2000'),
      cofins: rate('3', '100'),
      pisAt: 'lei-9715-1998: art. 8º I (0,65%); lei-10637-2002: art. 8º II',
      cofinsAt: 'lei-9718-1998: art. 8º (3%); lei-10833-2003: art. 10 II',
    },
  ]
  const rules: Rule[] = methods.flatMap((method) => [
    goodsRule({
      ruleKey: `pis.${method.regime}`,
      code: 'PIS',
      priority: 100,
      issuerRegime: method.regime,
      effectiveTo: UNTIL_REFORM,
      rate: method.pis,
      expression: expression(revenue),
      sourceLocator: `${method.pisAt}; ${exclusions}`,
    }),
    goodsRule({
      ruleKey: `cofins.${method.regime}`,
      code: 'COFINS',
      priority: 100,
      issuerRegime: method.regime,
      effectiveTo: UNTIL_REFORM,
      rate: method.cofins,
      expression: expression(revenue),
      sourceLocator: `${method.cofinsAt}; ${exclusions}`,
    }),
  ])
  const sources = [
    'lei-10637-2002',
    'lei-10833-2003',
    'lei-9715-1998',
    'lei-9718-1998',
    'dl-1598-1977',
    'pgfn-parecer-7698-2021',
  ]
  return { rules, entries: [] as Entry[], sources }
}

/**
 * The goods package: ICMS, IPI and PIS/Cofins together, since their formulas read one another
 * (ICMS over net + IPI; PIS/Cofins over net − ICMS) and a package is checked on its own.
 */
export function goodsPackage(
  manifest: SourceManifest,
  tipi: ReadonlyMap<string, string>,
  ncms: readonly string[],
) {
  const parts = [icmsPart(), ipiPart(tipi, ncms), pisCofinsPart()]
  return publication(
    'phase85.goods.sp-rj-ba.2026',
    'Horizon — reviewed reading of ICMS (SP, RJ, BA), IPI (TIPI) and PIS/Cofins (Phase 85)',
    source(manifest, 'ricms-sp-art-52').uri,
    parts.flatMap((part) => part.sources).map((id) => source(manifest, id)),
    parts.flatMap((part) => part.rules),
    parts.flatMap((part) => part.entries),
  )
}

/** ISS in São Paulo for the declared service. */
export function issPackage(manifest: SourceManifest) {
  const rules: Rule[] = [
    {
      ...goodsRule({
        ruleKey: `iss.3550308.${DECLARED_SERVICE}`,
        code: 'ISS',
        priority: 100,
        issuerMunicipality: SAO_PAULO_CITY,
        classification: { kind: 'service', code: DECLARED_SERVICE },
        effectiveTo: UNTIL_BLEND,
        rate: rate('29', '1000'),
        expression: expression(NET),
        sourceLocator:
          'sp-lei-13701-2003: art. 16 III (2,9% for item 1); lc-116-2003: arts. 3º and 7º, subitem 1.01',
      }),
      model: 'nfse',
    },
  ]
  const entries: Entry[] = [
    {
      family: 'service',
      code: DECLARED_SERVICE,
      description: 'Análise e desenvolvimento de sistemas (LC 116, subitem 1.01)',
      model: '*',
      jurisdiction: 'BR',
      effectiveFrom: FROM,
      sourceLocator: 'lc-116-2003: lista, subitem 1.01',
    },
  ]
  return publication(
    'phase85.iss.sao-paulo.2026',
    'Horizon — reviewed reading of São Paulo ISS (Phase 85)',
    source(manifest, 'sp-lei-13701-2003').uri,
    ['lc-116-2003', 'sp-lei-13701-2003'].map((id) => source(manifest, id)),
    rules,
    entries,
  )
}

/** A package's rules as a workspace resolves them once it has adopted the package from its start. */
export function publicationAsTaxRules(pack: CatalogPublication, tenantId: string): TaxRule[] {
  const packageDigest =
    pack.artifact?.digest ?? createHash('sha256').update(pack.bytes).digest('hex')
  const packageId = deterministicUuid('catalog', pack.authority, packageDigest)
  return (pack.rules as Rule[]).map((rule) => ({
    tenantId,
    group: rule.group,
    code: rule.code,
    precedence: rule.precedence,
    priority: rule.priority,
    dateBasis: rule.dateBasis ?? 'issue_date',
    effectiveFrom: rule.effectiveFrom,
    ...(rule.effectiveTo ? { effectiveTo: rule.effectiveTo } : {}),
    active: true,
    scope: {
      model: rule.model,
      environment: rule.environment,
      purpose: rule.purpose ?? 'normal',
      ...(rule.operation ? { operation: rule.operation } : {}),
      ...(rule.issuerRegime ? { issuerRegime: rule.issuerRegime } : {}),
      ...(rule.recipientRegime ? { recipientRegime: rule.recipientRegime } : {}),
      ...(rule.originState ? { originState: rule.originState } : {}),
      ...(rule.destinationState ? { destinationState: rule.destinationState } : {}),
      ...(rule.recipientTaxpayer !== undefined
        ? { recipientTaxpayer: rule.recipientTaxpayer }
        : {}),
      ...(rule.issuerMunicipality ? { issuerMunicipality: rule.issuerMunicipality } : {}),
      ...(rule.fact ? { fact: rule.fact } : {}),
      ...(rule.classification ? { classification: rule.classification } : {}),
    },
    rate: rule.rate,
    formula: rule.formula,
    ...(rule.expression ? { expression: ruleExpressionSchema.parse(rule.expression) } : {}),
    rule: {
      id: deterministicUuid('catalog', packageId, rule.ruleKey, String(rule.version)),
      version: rule.version,
    },
    source: {
      packageId,
      digest: packageDigest,
      uri: pack.sourceUri,
      section: rule.sourceLocator,
      approved: true,
    },
  }))
}
