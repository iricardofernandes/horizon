import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { FiscalCalculationInput } from '@horizon/contracts'
import { calculateFiscal } from './calculation'
import { canonicalDigest } from './canonical-json'
import { type CatalogPublication, FiscalCatalog } from './catalog'
import { ruleExpressionSchema } from './formula'
import { buildRtcPackage, inForce, type ReferenceRates, readCalculator } from './rtc-package'
import { deterministicUuid } from './rule-rows'
import { resolveTaxRules, type TaxRule } from './rules'

/**
 * Phase 84 (ADR 0072): the official calculator as the oracle of IBS and CBS.
 *   build --database <calculadora-pro.db> --artifact <calculadora.zip> --out <package.json>
 *         [--hypothetical-2027]          the same classes at stated nominal rates, never published
 *   oracle --package <package.json> --database <db> --url <http://127.0.0.1:18080>
 *         --out <report.json> [--cases 3000] [--seed 84]
 *   publish --package <package.json>     as the migration role (DATABASE_MIGRATION_URL)
 */

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}
const required = (name: string): string => {
  const found = option(name)
  if (!found) throw new Error(`--${name} is required`)
  return found
}

/** Stated for the 2027 mechanics run only: IBS 0,05% + 0,05% is the law (LC 214 art. 344); CBS is not. */
const HYPOTHETICAL_2027: ReferenceRates = { CBS: '8.8', IBSUF: '0.05', IBSMun: '0.05' }

type RtcPackage = CatalogPublication & {
  calculatorVersion: string
  hypothetical: boolean
  rates: ReferenceRates
  window: { effectiveFrom: string; effectiveTo: string }
  excluded: { code: string; why: string }[]
}

async function build(): Promise<unknown> {
  const artifact = await readFile(required('artifact'))
  const digest = createHash('sha256').update(artifact).digest('hex')
  const hypothetical = process.argv.includes('--hypothetical-2027')
  const window = hypothetical
    ? { effectiveFrom: '2027-01-01', effectiveTo: '2028-01-01' }
    : { effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' }
  const calculator = await readCalculator(required('database'), window)
  const rates = hypothetical ? HYPOTHETICAL_2027 : calculator.rates2026
  const label = hypothetical ? 'rtc.v0059.hypothetical-2027' : 'rtc.v0059.2026'
  const built = buildRtcPackage({
    label,
    classes: calculator.classes,
    ncms: calculator.ncms,
    rates,
    window,
  })
  const manifest = {
    calculatorVersion: calculator.version,
    artifactDigest: digest,
    label,
    rates,
    window,
    // The package is named by this manifest, so a different build is a different package.
    contentDigest: canonicalDigest({ entries: built.entries, rules: built.rules }),
  }
  const publication: RtcPackage = {
    authority: hypothetical
      ? `Horizon — hypothetical 2027 nominal rates over ${calculator.version} (never law)`
      : `Receita Federal do Brasil / SERPRO — Calculadora RTC ${calculator.version} (IBS/CBS 2026)`,
    sourceUri: 'https://obs-13820-calcpr-apr.obsv3.br-df-1.hcs.serpro.gov.br/calculadora.zip',
    publishedAt: '2026-09-30',
    effectiveFrom: window.effectiveFrom,
    publisher: 'platform:phase84',
    // Named by its manifest, which carries the calculator's digest and the package's own content:
    // one calculator yields several packages (2026, and later builds), so its digest cannot name one.
    entries: built.entries,
    rules: built.rules as never,
    bytes: Buffer.from(JSON.stringify(manifest)),
    calculatorVersion: calculator.version,
    hypothetical,
    rates,
    window,
    excluded: built.excluded,
  }
  await writeFile(
    required('out'),
    `${JSON.stringify({ ...publication, bytes: manifest }, null, 1)}\n`,
  )
  return {
    calculatorVersion: calculator.version,
    classes: new Set(built.rules.map((rule) => rule.classification.code)).size,
    rules: built.rules.length,
    references: built.entries.length,
    excluded: built.excluded.length,
  }
}

async function loadPackage(path: string): Promise<RtcPackage> {
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  return { ...parsed, bytes: Buffer.from(JSON.stringify(parsed.bytes)) }
}

/** The package's rules as a workspace would resolve them after adopting it. */
function asTaxRules(pack: RtcPackage, tenantId: string): TaxRule[] {
  // As the catalogue names it: by the digest of its source bytes, the manifest.
  const packageDigest = createHash('sha256').update(pack.bytes).digest('hex')
  const packageId = deterministicUuid('catalog', pack.authority, packageDigest)
  return (pack.rules as unknown as Record<string, never>[]).map((raw) => {
    const rule = raw as unknown as {
      ruleKey: string
      version: number
      code: string
      priority: number
      model: '55' | '65'
      classification: { kind: 'class_trib'; code: string }
      effectiveFrom: string
      effectiveTo: string
      rate: { numerator: string; denominator: string }
      expression: unknown
      sourceLocator: string
    }
    return {
      tenantId,
      group: 'ibsCbs',
      code: rule.code,
      precedence: 'default',
      priority: rule.priority,
      dateBasis: 'issue_date',
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo,
      active: true,
      scope: {
        model: rule.model,
        environment: 'simulation',
        purpose: 'normal',
        classification: rule.classification,
      },
      rate: rule.rate,
      formula: 'EXPRESSION',
      expression: ruleExpressionSchema.parse(rule.expression),
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
    }
  })
}

function generator(seed: number) {
  let state = seed >>> 0
  return (limit: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state % limit
  }
}

/** Minor units from the oracle's two-decimal strings. */
const cents = (value: unknown): bigint => {
  const text = String(value ?? '0')
  const [whole = '0', fraction = ''] = text.split('.')
  const sign = whole.startsWith('-') ? -1n : 1n
  return sign * (BigInt(whole.replace('-', '')) * 100n + BigInt(`${fraction}00`.slice(0, 2)))
}

type Case = {
  id: number
  date: string
  municipality: number
  state: string
  stateCode: string
  items: { classTrib: string; situation: string; ncm: string; base: bigint }[]
}

async function oracle(): Promise<unknown> {
  const pack = await loadPackage(required('package'))
  const calculator = await readCalculator(required('database'), pack.window)
  const url = required('url').replace(/\/$/, '')
  const total = Number(option('cases') ?? '3000')
  const next = generator(Number(option('seed') ?? '84'))
  const tenantId = '00000000-0000-4000-8000-000000000084'
  const taxRules = asTaxRules(pack, tenantId)
  const situations = new Map(calculator.classes.map((klass) => [klass.code, klass.situation]))
  const classes = [...new Set(taxRules.map((rule) => rule.scope.classification?.code ?? ''))].sort()
  const eightDigit = calculator.ncms.filter((ncm) => /^\d{8}$/.test(ncm.code))
  // An NCM in force on the day and, where the class lists NCMs, one it lists on that day:
  // the class's applicability is the caller's (decision 4), so the corpus asks only what applies.
  const ncmFor = (classTrib: string, day: string) => {
    const listed = calculator.applicableNcms[classTrib]
    const links = listed?.filter((row) => inForce(row, day)) ?? []
    // The calculator repeats a prefix once per exception, so the exceptions are their union.
    const covers = (code: string) => {
      const matching = links.filter((link) => code.startsWith(link.code))
      return (
        matching.length > 0 &&
        !matching.some((link) =>
          link.except.some((out) => inForce(out, day) && code.startsWith(out.code)),
        )
      )
    }
    const pool = eightDigit
      .filter((ncm) => inForce(ncm, day))
      .filter((ncm) => !calculator.selectiveNcms.some((prefix) => ncm.code.startsWith(prefix)))
      .map((ncm) => ncm.code)
      .filter((code) => !listed?.length || covers(code))
    return pool.length ? pool[next(pool.length)] : undefined
  }
  const { effectiveFrom, effectiveTo } = pack.window
  const lastDay = new Date(new Date(`${effectiveTo}T00:00:00Z`).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10)
  const dayCount = Math.round(
    (new Date(`${effectiveTo}T00:00:00Z`).getTime() -
      new Date(`${effectiveFrom}T00:00:00Z`).getTime()) /
      86_400_000,
  )
  const dateFor = (index: number) =>
    index % 7 === 0
      ? effectiveFrom
      : index % 7 === 1
        ? lastDay
        : new Date(new Date(`${effectiveFrom}T00:00:00Z`).getTime() + next(dayCount) * 86_400_000)
            .toISOString()
            .slice(0, 10)
  const baseFor = () => {
    const kind = next(4)
    if (kind === 0) return BigInt(next(1000) + 1)
    if (kind === 1) return BigInt(next(100_000) + 1)
    if (kind === 2) return BigInt(next(1_000_000_000) + 1)
    // Values whose tax falls near half a cent, where rounding decides.
    return BigInt(next(20_000) * 50 + 25)
  }
  // A day on which the class lists no NCM in force is not asked: it applies to nothing that day.
  const notApplicable: { classTrib: string; date: string }[] = []
  const cases: Case[] = Array.from({ length: total }, (_, id): Case | undefined => {
    const municipality = calculator.municipalities[next(calculator.municipalities.length)]
    // One to three items, all of one class, so an oracle refusal is always that class's own.
    const itemCount = 1 + next(3)
    const classTrib = classes[id % classes.length] ?? '000001'
    const date = dateFor(id)
    const items = Array.from({ length: itemCount }, () => ({
      classTrib,
      situation: situations.get(classTrib) ?? '000',
      ncm: ncmFor(classTrib, date),
      base: baseFor(),
    }))
    if (items.some((item) => item.ncm === undefined)) {
      notApplicable.push({ classTrib, date })
      return undefined
    }
    return {
      id,
      date,
      municipality: municipality?.code ?? 3550308,
      state: municipality?.state ?? 'SP',
      stateCode: municipality?.stateCode ?? '35',
      items: items.map((item) => ({ ...item, ncm: item.ncm ?? '' })),
    }
  }).filter((entry): entry is Case => entry !== undefined)

  const results: {
    id: number
    classTrib: string
    outcome: 'agree' | 'differ' | 'refused'
    detail?: unknown
  }[] = []
  const nominal = pack.hypothetical
    ? {
        cbs: Number(pack.rates.CBS),
        ibsEstadual: Number(pack.rates.IBSUF),
        ibsMunicipal: Number(pack.rates.IBSMun),
      }
    : undefined
  const run = async (entry: Case) => {
    const response = await fetch(`${url}/api/calculadora/regime-geral`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: String(entry.id),
        versao: '1.0.0',
        dataHoraEmissao: `${entry.date}T12:00:00-03:00`,
        municipio: entry.municipality,
        uf: entry.state,
        itens: entry.items.map((item, index) => ({
          numero: index + 1,
          ncm: item.ncm,
          quantidade: 1,
          unidade: 'UN',
          cst: item.situation,
          baseCalculo: Number(item.base) / 100,
          cClassTrib: item.classTrib,
          ...(nominal ? { aliquotasNominais: nominal } : {}),
        })),
      }),
    })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (response.status !== 200) {
      for (const item of entry.items)
        results.push({
          id: entry.id,
          classTrib: item.classTrib,
          outcome: 'refused',
          detail: String(body.title ?? body.detail ?? response.status).slice(0, 160),
        })
      return
    }
    const input: FiscalCalculationInput = {
      schemaVersion: 1,
      tenantId,
      issuerEstablishmentId: tenantId,
      model: '55',
      environment: 'simulation',
      operation: 'rtc-oracle',
      purpose: 'normal',
      issuer: {
        regime: 'normal',
        stateCode: entry.stateCode,
        municipalityCode: String(entry.municipality),
      },
      recipient: {
        regime: 'normal',
        stateCode: entry.stateCode,
        municipalityCode: String(entry.municipality),
        taxpayer: true,
      },
      origin: {
        countryCode: '1058',
        stateCode: entry.stateCode,
        municipalityCode: String(entry.municipality),
      },
      destination: {
        countryCode: '1058',
        stateCode: entry.stateCode,
        municipalityCode: String(entry.municipality),
      },
      issueDate: entry.date,
      currency: 'BRL',
      lines: entry.items.map((item) => ({
        id: randomUUID(),
        itemId: randomUUID(),
        quantity: '1',
        unitPrice: (Number(item.base) / 100).toFixed(2).replace(/\.?0+$/, '') || '0',
        discount: { amount: '0', currency: 'BRL' },
        charges: { amount: '0', currency: 'BRL' },
        classifications: { ncm: item.ncm, classTrib: item.classTrib },
        taxFacts: {},
      })),
    }
    const resolution = resolveTaxRules(input, taxRules, 2)
    const calculated = resolution.supported ? calculateFiscal(input, resolution.rules) : resolution
    const objects = (body.objetos ?? []) as Record<string, unknown>[]
    entry.items.forEach((item, index) => {
      const line = input.lines[index]
      const engineLine =
        calculated.supported && 'lines' in calculated
          ? calculated.lines.find((candidate) => candidate.lineId === line?.id)
          : undefined
      const group = (
        objects.find((object) => Number(object.nObj) === index + 1)?.tribCalc as
          | Record<string, Record<string, unknown>>
          | undefined
      )?.IBSCBS?.gIBSCBS as Record<string, Record<string, unknown> | string> | undefined
      const theirs = {
        base: cents(group?.vBC),
        CBS: cents((group?.gCBS as Record<string, unknown> | undefined)?.vCBS),
        IBS_UF: cents((group?.gIBSUF as Record<string, unknown> | undefined)?.vIBSUF),
        IBS_MUN: cents((group?.gIBSMun as Record<string, unknown> | undefined)?.vIBSMun),
      }
      const component = (code: string) =>
        engineLine?.components.ibsCbs.find((candidate) => candidate.code === code)
      const ours = {
        base: BigInt(component('CBS')?.base.amount ?? '-1'),
        CBS: BigInt(component('CBS')?.amount.amount ?? '-1'),
        IBS_UF: BigInt(component('IBS_UF')?.amount.amount ?? '-1'),
        IBS_MUN: BigInt(component('IBS_MUN')?.amount.amount ?? '-1'),
      }
      // Without a gIBSCBS group the oracle states no base; only the amounts are compared.
      const agree =
        (!group || ours.base === theirs.base) &&
        ours.CBS === theirs.CBS &&
        ours.IBS_UF === theirs.IBS_UF &&
        ours.IBS_MUN === theirs.IBS_MUN
      results.push({
        id: entry.id,
        classTrib: item.classTrib,
        outcome: agree ? 'agree' : 'differ',
        ...(agree
          ? {}
          : {
              detail: {
                date: entry.date,
                base: String(item.base),
                ours: Object.fromEntries(Object.entries(ours).map(([k, v]) => [k, String(v)])),
                theirs: Object.fromEntries(Object.entries(theirs).map(([k, v]) => [k, String(v)])),
                unsupported: calculated.supported ? undefined : calculated,
              },
            }),
      })
    })
  }
  for (let start = 0; start < cases.length; start += 8)
    await Promise.all(cases.slice(start, start + 8).map(run))

  const byClass = new Map<
    string,
    { agree: number; differ: number; refused: number; differences: unknown[]; refusals: string[] }
  >()
  for (const result of results) {
    const entry = byClass.get(result.classTrib) ?? {
      agree: 0,
      differ: 0,
      refused: 0,
      differences: [],
      refusals: [],
    }
    entry[result.outcome] += 1
    if (result.outcome === 'differ' && entry.differences.length < 3)
      entry.differences.push(result.detail)
    if (result.outcome === 'refused' && !entry.refusals.includes(String(result.detail)))
      entry.refusals.push(String(result.detail))
    byClass.set(result.classTrib, entry)
  }
  const matrix = [...byClass.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([classTrib, entry]) => ({
      classTrib,
      supported: entry.differ === 0 && entry.refused === 0 && entry.agree > 0,
      ...entry,
    }))
  const report = {
    phase: 84,
    kind: pack.hypothetical ? 'oracle-mechanics-hypothetical-2027' : 'oracle-2026',
    calculatorVersion: pack.calculatorVersion,
    artifactDigest: JSON.parse(pack.bytes.toString()).artifactDigest,
    packageDigest: createHash('sha256').update(pack.bytes).digest('hex'),
    rates: pack.rates,
    window: pack.window,
    seed: Number(option('seed') ?? '84'),
    documents: cases.length,
    notApplicable: notApplicable.length,
    lines: results.length,
    agree: results.filter((result) => result.outcome === 'agree').length,
    differ: results.filter((result) => result.outcome === 'differ').length,
    refused: results.filter((result) => result.outcome === 'refused').length,
    classes: {
      supported: matrix.filter((row) => row.supported).length,
      differing: matrix.filter((row) => row.differ > 0).length,
      refusedByOracle: matrix.filter((row) => row.refused > 0 && row.differ === 0).length,
    },
    notModelled: pack.excluded,
    matrix,
  }
  await writeFile(required('out'), `${JSON.stringify(report, null, 1)}\n`)
  // ADR 0072: a class in the package without the oracle's agreement has no evidence.
  const unproven = classes.filter(
    (code) => !matrix.some((row) => row.classTrib === code && row.supported),
  )
  if (report.differ > 0 || report.refused > 0 || unproven.length > 0) process.exitCode = 1
  return {
    documents: report.documents,
    lines: report.lines,
    agree: report.agree,
    differ: report.differ,
    refused: report.refused,
    classes: report.classes,
    unproven,
  }
}

async function publish(): Promise<unknown> {
  const pack = await loadPackage(required('package'))
  if (pack.hypothetical) throw new Error('A hypothetical package is never published')
  const url = process.env.DATABASE_MIGRATION_URL
  if (!url) throw new Error('DATABASE_MIGRATION_URL is required')
  const catalog = new FiscalCatalog(url, 300_000)
  try {
    const {
      calculatorVersion: _v,
      hypothetical: _h,
      rates: _r,
      window: _w,
      excluded: _e,
      ...publication
    } = pack
    return await catalog.publish(publication)
  } finally {
    await catalog.close()
  }
}

const actions: Record<string, () => Promise<unknown>> = { build, oracle, publish }
const action = process.argv[2] ?? ''
const runAction = actions[action]
if (!runAction) {
  console.error(`usage: phase84-oracle-cli <${Object.keys(actions).join('|')}> [options]`)
  process.exit(2)
}
runAction()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
