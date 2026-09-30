import { decimal, multiply, reduce, subtract } from './exact-decimal'
import { FORMULA_VERSION } from './formula'

/**
 * The 2026 IBS/CBS catalogue package, built from the official calculator's own database
 * (Phase 84, ADR 0072), never typed by hand. The mapping is pure, so it is tested without the
 * database; `readCalculator` below reads the rows.
 */

/** The calculator's treatments the engine models, with the outcome each gives. */
export const MODELLED_TREATMENTS: Readonly<
  Record<
    number,
    { outcome: 'levied' | 'exempt' | 'suspended' | 'not-levied'; baseExcluded?: string }
  >
> = {
  3: { outcome: 'levied' },
  4: { outcome: 'levied' },
  5: { outcome: 'levied' },
  6: { outcome: 'levied' },
  7: { outcome: 'levied' },
  8: { outcome: 'levied' },
  9: { outcome: 'levied' },
  10: { outcome: 'levied' },
  11: { outcome: 'levied' },
  12: { outcome: 'levied' },
  13: { outcome: 'levied' },
  14: { outcome: 'levied' },
  15: { outcome: 'levied' },
  16: { outcome: 'levied' },
  // `baseCalculoInformada*0.5` and `…*(1-100/100)` in the calculator's own formulas.
  17: { outcome: 'levied', baseExcluded: '1/2' },
  18: { outcome: 'exempt' },
  19: { outcome: 'not-levied' },
  40: { outcome: 'levied', baseExcluded: '1/1' },
}

export type CalculatorClass = {
  code: string
  description: string
  situation: string
  treatmentId: number
  treatment: string
  startsOn: string
  endsOn: string | null
  documentModels: readonly string[]
  /** Percent reductions by tribute: CBS, IBSUF, IBSMun. */
  reductions: Readonly<Record<'CBS' | 'IBSUF' | 'IBSMun', string>>
}

export type ReferenceRates = Readonly<Record<'CBS' | 'IBSUF' | 'IBSMun', string>>

export type PackageWindow = { effectiveFrom: string; effectiveTo: string }

const COMPONENTS = [
  { tribute: 'CBS', code: 'CBS' },
  { tribute: 'IBSUF', code: 'IBS_UF' },
  { tribute: 'IBSMun', code: 'IBS_MUN' },
] as const

const MODELS = ['55', '65'] as const

/** `reference% × (1 − reduction%)`, as an exact fraction of one. */
export function effectiveRate(referencePercent: string, reductionPercent: string) {
  const hundred = decimal('100')
  const reference = reduce({
    numerator: decimal(referencePercent).numerator,
    denominator: decimal(referencePercent).denominator * hundred.numerator,
  })
  const kept = subtract(
    decimal('1'),
    reduce({
      numerator: decimal(reductionPercent).numerator,
      denominator: decimal(reductionPercent).denominator * hundred.numerator,
    }),
  )
  const rate = multiply(reference, kept)
  return { numerator: rate.numerator.toString(), denominator: rate.denominator.toString() }
}

/** Whether a class can be modelled, and why not when it cannot. */
export function modelled(klass: CalculatorClass, window: PackageWindow): string | null {
  if (!MODELLED_TREATMENTS[klass.treatmentId])
    return `treatment ${klass.treatmentId} (${klass.treatment}) is not modelled`
  if (!MODELS.some((model) => klass.documentModels.includes(model)))
    return 'not applicable to NF-e or NFC-e'
  if (klass.endsOn && klass.endsOn <= klass.startsOn) return 'withdrawn'
  if (klass.endsOn && klass.endsOn <= window.effectiveFrom) return 'not in force in the window'
  if (klass.startsOn >= window.effectiveTo) return 'not in force in the window'
  return null
}

export type PackageRule = {
  ruleKey: string
  version: number
  group: 'ibsCbs'
  code: string
  precedence: 'default'
  priority: number
  model: '55' | '65'
  environment: 'simulation'
  classification: { kind: 'class_trib'; code: string }
  effectiveFrom: string
  effectiveTo: string
  rate: { numerator: string; denominator: string }
  formula: 'EXPRESSION'
  expression: {
    version: typeof FORMULA_VERSION
    base: unknown
    outcome: 'levied' | 'exempt' | 'suspended' | 'not-levied'
    rounding: 'half-even'
  }
  sourceLocator: string
}

export type PackageReference = {
  family: 'class_trib' | 'ncm'
  code: string
  description: string
  model: '*'
  jurisdiction: 'BR'
  effectiveFrom: string
  effectiveTo?: string
  sourceLocator: string
}

/** The rules and references of one window, for every class the engine models. */
export function buildRtcPackage(input: {
  label: string
  classes: readonly CalculatorClass[]
  ncms: readonly { code: string; description: string; startsOn: string; endsOn: string | null }[]
  rates: ReferenceRates
  window: PackageWindow
}): {
  rules: PackageRule[]
  entries: PackageReference[]
  excluded: { code: string; why: string }[]
} {
  const rules: PackageRule[] = []
  const entries: PackageReference[] = []
  const excluded: { code: string; why: string }[] = []
  for (const klass of [...input.classes].sort((a, b) => a.code.localeCompare(b.code))) {
    const why = modelled(klass, input.window)
    if (why) {
      excluded.push({ code: klass.code, why })
      continue
    }
    const treatment = MODELLED_TREATMENTS[klass.treatmentId]
    if (!treatment) continue
    const effectiveFrom =
      klass.startsOn > input.window.effectiveFrom ? klass.startsOn : input.window.effectiveFrom
    const effectiveTo =
      klass.endsOn && klass.endsOn < input.window.effectiveTo
        ? klass.endsOn
        : input.window.effectiveTo
    entries.push({
      family: 'class_trib',
      code: klass.code,
      description: klass.description.slice(0, 1000),
      model: '*',
      jurisdiction: 'BR',
      effectiveFrom,
      effectiveTo,
      sourceLocator: `calculadora-pro.db:CLASSIFICACAO_TRIBUTARIA:CLTR_CD=${klass.code}`,
    })
    const base = treatment.baseExcluded
      ? {
          reduce: {
            base: { line: 'net' },
            by: {
              rate: {
                numerator: treatment.baseExcluded.split('/')[0],
                denominator: treatment.baseExcluded.split('/')[1],
              },
            },
          },
        }
      : { line: 'net' }
    for (const model of MODELS) {
      if (!klass.documentModels.includes(model)) continue
      for (const component of COMPONENTS)
        rules.push({
          ruleKey: `${input.label}.${klass.code}.${component.code.toLowerCase()}.m${model}`,
          version: 1,
          group: 'ibsCbs',
          code: component.code,
          precedence: 'default',
          priority: 100,
          model,
          environment: 'simulation',
          classification: { kind: 'class_trib', code: klass.code },
          effectiveFrom,
          effectiveTo,
          rate: effectiveRate(input.rates[component.tribute], klass.reductions[component.tribute]),
          formula: 'EXPRESSION',
          // The official calculator rounds half to even; its answers at half a cent prove it.
          expression: {
            version: FORMULA_VERSION,
            base,
            outcome: treatment.outcome,
            rounding: 'half-even',
          },
          sourceLocator:
            `calculadora-pro.db:${klass.code}:${component.tribute}:treatment ${klass.treatmentId} (${klass.treatment.slice(0, 80)}):reduction ${klass.reductions[component.tribute]}%`.slice(
              0,
              300,
            ),
        })
    }
  }
  for (const ncm of input.ncms) {
    if (!/^\d{8}$/.test(ncm.code)) continue
    if (ncm.endsOn && ncm.endsOn <= input.window.effectiveFrom) continue
    entries.push({
      family: 'ncm',
      code: ncm.code,
      description: ncm.description.slice(0, 1000) || ncm.code,
      model: '*',
      jurisdiction: 'BR',
      effectiveFrom: ncm.startsOn,
      ...(ncm.endsOn && ncm.endsOn !== '9999-12-31' ? { effectiveTo: ncm.endsOn } : {}),
      sourceLocator: `calculadora-pro.db:NCM:NCM_CD=${ncm.code}`,
    })
  }
  return { rules, entries, excluded }
}

export type Validity = { code: string; startsOn: string; endsOn: string | null }

/** A class's NCM (or NCM prefix) and the prefixes the annex excepts from it ("exceto …"). */
export type ApplicableNcm = Validity & { except: readonly Validity[] }

/** In force on a day: `endsOn` is the last day, as the calculator stores it. */
export const inForce = (row: Omit<Validity, 'code'>, day: string) =>
  row.startsOn.slice(0, 10) <= day && (row.endsOn === null || row.endsOn.slice(0, 10) >= day)

/**
 * The rows the builder needs, read from the calculator's SQLite database, each as in force in
 * the window. A class code is reused with another meaning from 2027 (000001 is full taxation in
 * 2026, a first supply of goods from 2027), so every row is keyed by the class's row, never its
 * code, and only the rows overlapping the window are read. A row ending on the day it starts
 * (220001 to 220003) was withdrawn.
 */
export async function readCalculator(
  databasePath: string,
  window: PackageWindow,
): Promise<{
  version: string
  classes: CalculatorClass[]
  ncms: { code: string; description: string; startsOn: string; endsOn: string | null }[]
  rates2026: ReferenceRates
  applicableNcms: Record<string, ApplicableNcm[]>
  /** NCM prefixes the Imposto Seletivo reaches in the window, which this phase does not model. */
  selectiveNcms: string[]
  municipalities: { code: number; stateCode: string; state: string }[]
}> {
  // Asked of Node itself: bundlers do not know `node:sqlite` and would rewrite its specifier.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(databasePath, { readOnly: true })
  const during = (prefix: string) =>
    `${prefix}_INICIO_VIGENCIA < :to and (${prefix}_FIM_VIGENCIA is null or ${prefix}_FIM_VIGENCIA > :from)`
  const bounds = { from: window.effectiveFrom, to: window.effectiveTo }
  try {
    const version = String(
      (
        db
          .prepare(
            'select VRBD_VERSAO_BASE_DADO version from VERSAO_BASE_DADO order by VRBD_ID desc limit 1',
          )
          .get() as Record<string, unknown> | undefined
      )?.version ?? '',
    )
    const reductions = new Map<number, Record<string, string>>()
    for (const row of db
      .prepare(
        `select pr.PERE_CLTR_ID id, t.TBTO_SIGLA tribute, pr.PERE_VALOR value
         from PERCENTUAL_REDUCAO pr
         join TRIBUTO t on t.TBTO_ID = pr.PERE_TBTO_ID
         where ${during('pr.PERE')}`,
      )
      .all(bounds) as { id: number; tribute: string; value: number }[]) {
      const entry = reductions.get(Number(row.id)) ?? {}
      entry[row.tribute] = String(row.value)
      reductions.set(Number(row.id), entry)
    }
    const models = new Map<number, string[]>()
    for (const row of db
      .prepare(
        `select tc.TDCL_CLTR_ID id, td.TPDF_TIPO model from TIPO_DFE_CLASSIFICACAO tc
         join TIPO_DFE td on td.TPDF_ID = tc.TDCL_TPDF_ID
         where ${during('tc.TDCL')}`,
      )
      .all(bounds) as { id: number; model: number }[])
      models.set(Number(row.id), [...(models.get(Number(row.id)) ?? []), String(row.model)])
    const rows = db
      .prepare(
        `select ct.CLTR_ID id, ct.CLTR_CD code, ct.CLTR_DESCRICAO description,
             st.SITR_CD situation, tt.TRTR_ID treatmentId, tt.TRTR_DESCRICAO treatment,
             ct.CLTR_INICIO_VIGENCIA startsOn, ct.CLTR_FIM_VIGENCIA endsOn
           from CLASSIFICACAO_TRIBUTARIA ct
           join SITUACAO_TRIBUTARIA st on st.SITR_ID = ct.CLTR_SITR_ID
           join TRATAMENTO_CLASSIFICACAO tc on tc.TRCL_CLTR_ID = ct.CLTR_ID
           join TRATAMENTO_TRIBUTARIO tt on tt.TRTR_ID = tc.TRCL_TRTR_ID
           where ${during('ct.CLTR')} and ${during('tc.TRCL')}`,
      )
      .all(bounds) as (Omit<CalculatorClass, 'reductions' | 'documentModels'> & { id: number })[]
    // A later row of a code supersedes the earlier one from its start, as the calculator reads it.
    const latest = new Map<string, (typeof rows)[number]>()
    for (const row of rows) {
      const held = latest.get(row.code)
      if (
        !held ||
        row.startsOn > held.startsOn ||
        (row.startsOn === held.startsOn && row.id > held.id)
      )
        latest.set(row.code, row)
    }
    const chosen = new Set([...latest.values()].map((row) => Number(row.id)))
    const classes = [...latest.values()].map(({ id, ...row }) => {
      const reduction = reductions.get(Number(id)) ?? {}
      return {
        ...row,
        treatmentId: Number(row.treatmentId),
        documentModels: models.get(Number(id)) ?? [],
        reductions: {
          CBS: reduction.CBS ?? '0',
          IBSUF: reduction.IBSUF ?? '0',
          IBSMun: reduction.IBSMun ?? '0',
        },
      }
    })
    const ncms = db
      .prepare(
        `select NCM_CD code, NCM_DESCRICAO description, NCM_INICIO_VIGENCIA startsOn,
           NCM_FIM_VIGENCIA endsOn from NCM`,
      )
      .all() as { code: string; description: string; startsOn: string; endsOn: string | null }[]
    const rates: Record<string, string> = {}
    for (const row of db
      .prepare(
        `select t.TBTO_SIGLA tribute, ar.ALRE_VALOR value from ALIQUOTA_REFERENCIA ar
         join TRIBUTO t on t.TBTO_ID = ar.ALRE_TBTO_ID where ar.ALRE_INICIO_VIGENCIA = '2026-01-01'`,
      )
      .all() as { tribute: string; value: number }[])
      rates[row.tribute] = String(row.value)
    const exceptions = new Map<number, Validity[]>()
    for (const row of db
      .prepare(
        `select ENCM_NCMA_ID link, ENCM_NCM_CD code, ENCM_INICIO_VIGENCIA startsOn,
           ENCM_FIM_VIGENCIA endsOn from EXCECAO_NCM_APLICAVEL`,
      )
      .all() as (Validity & { link: number })[]) {
      const link = Number(row.link)
      exceptions.set(link, [
        ...(exceptions.get(link) ?? []),
        { code: row.code, startsOn: row.startsOn, endsOn: row.endsOn },
      ])
    }
    const applicableNcms: Record<string, ApplicableNcm[]> = {}
    for (const row of db
      .prepare(
        `select ct.CLTR_ID id, ct.CLTR_CD klass, na.NCMA_ID link, na.NCMA_NCM_CD code,
           na.NCMA_INICIO_VIGENCIA startsOn, na.NCMA_FIM_VIGENCIA endsOn from NCM_APLICAVEL na
         join CLASSIFICACAO_TRIBUTARIA ct on ct.CLTR_ID = na.NCMA_CLTR_ID
         where ${during('ct.CLTR')} and ${during('na.NCMA')}`,
      )
      .all(bounds) as (Validity & { id: number; klass: string; link: number })[]) {
      if (!chosen.has(Number(row.id))) continue
      applicableNcms[row.klass] = [
        ...(applicableNcms[row.klass] ?? []),
        {
          code: row.code,
          startsOn: row.startsOn,
          endsOn: row.endsOn,
          except: exceptions.get(Number(row.link)) ?? [],
        },
      ]
    }
    const selectiveNcms = (
      db
        .prepare(
          `select AAVP_NCM_CD code from ALIQUOTA_AD_VALOREM_PRODUTO where ${during('AAVP')}
           union select AARP_NCM_CD code from ALIQUOTA_AD_REM_PRODUTO where ${during('AARP')}`,
        )
        .all(bounds) as { code: string }[]
    ).map((row) => row.code)
    const municipalities = (
      db
        .prepare(
          `select m.MUNI_CD code, u.UF_CD stateCode, u.UF_SIGLA state from MUNICIPIO m
           join UF u on u.UF_CD = m.MUNI_UF_CD order by m.MUNI_CD`,
        )
        .all() as { code: number; stateCode: number; state: string }[]
    ).map((row) => ({ code: Number(row.code), stateCode: String(row.stateCode), state: row.state }))
    return {
      version,
      municipalities,
      classes,
      ncms,
      rates2026: { CBS: rates.CBS ?? '0', IBSUF: rates.IBSUF ?? '0', IBSMun: rates.IBSMun ?? '0' },
      applicableNcms,
      selectiveNcms,
    }
  } finally {
    db.close()
  }
}
