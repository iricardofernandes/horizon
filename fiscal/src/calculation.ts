import {
  type FiscalCalculationInput,
  type FiscalCalculationOutcome,
  fiscalCalculationInputSchema,
  fiscalCalculationOutcomeSchema,
} from '@horizon/contracts'
import { canonicalDigest } from './canonical-json'
import {
  decimal,
  integer,
  multiply,
  type Rational,
  reduce,
  roundHalfAwayFromZero,
} from './exact-decimal'

export type ResolvedComponentRule = {
  group: 'legacy' | 'ibsCbs'
  code: string
  rate: { numerator: string; denominator: string }
  formula: 'LINE_NET_TIMES_RATE'
  rule: { id: string; version: number }
  source: {
    packageId: string
    digest: string
    uri: string
    section: string
    approved: boolean
  }
}

export type ResolvedRuleSet = {
  schemaVersion: 1
  currencyMinorUnitScale: number
  explanationTemplateVersion: 'fiscal-explanation-v1'
  lines: Readonly<Record<string, readonly ResolvedComponentRule[]>>
}

type SupportedResult = Extract<FiscalCalculationOutcome, { supported: true }>
type CalculatedLine = SupportedResult['lines'][number]
type CalculatedComponent = CalculatedLine['components']['legacy'][number]

export function calculateFiscal(
  candidate: unknown,
  resolvedRules: ResolvedRuleSet,
): FiscalCalculationOutcome {
  const parsed = fiscalCalculationInputSchema.safeParse(candidate)
  if (!parsed.success)
    return unsupported('INVALID_FISCAL_INPUT', 'Fiscal calculation input is invalid')
  const duplicateLine = findDuplicate(parsed.data.lines.map((line) => line.id))
  if (duplicateLine)
    return unsupported(
      'INVALID_FISCAL_INPUT',
      'Fiscal line identifiers must be unique',
      duplicateLine,
    )
  const input = normalizeInput(parsed.data)
  const inputDigest = canonicalDigest(input)
  const normalizedRules = normalizeRules(resolvedRules)
  const ruleProblem = validateRules(input, normalizedRules, inputDigest)
  if (ruleProblem) return ruleProblem
  const rulesDigest = canonicalDigest(normalizedRules)

  const lines: CalculatedLine[] = []
  for (const line of input.lines) {
    const lineRules = normalizedRules.lines[line.id]
    if (!lineRules) throw new Error('Resolved rule validation invariant failed')
    const calculated = calculateLine(input, line, lineRules, normalizedRules.currencyMinorUnitScale)
    if (BigInt(calculated.net.amount) < 0n)
      return unsupported(
        'INVALID_FISCAL_INPUT',
        'Discount cannot make a line net amount negative',
        line.id,
        inputDigest,
      )
    lines.push(calculated)
  }
  const currency = input.currency
  const totals = {
    gross: money(sum(lines.map((line) => line.gross.amount)), currency),
    discounts: money(sum(input.lines.map((line) => line.discount.amount)), currency),
    charges: money(sum(input.lines.map((line) => line.charges.amount)), currency),
    net: money(sum(lines.map((line) => line.net.amount)), currency),
    legacyTax: money(
      sum(
        lines.flatMap((line) => line.components.legacy.map((component) => component.amount.amount)),
      ),
      currency,
    ),
    ibsCbsTax: money(
      sum(
        lines.flatMap((line) => line.components.ibsCbs.map((component) => component.amount.amount)),
      ),
      currency,
    ),
  }
  const withoutDigest = {
    schemaVersion: 1 as const,
    supported: true as const,
    inputDigest,
    rulesDigest,
    lines,
    totals,
    reconciliation: {
      lineNetSum: totals.net,
      legacyComponentSum: totals.legacyTax,
      ibsCbsComponentSum: totals.ibsCbsTax,
      balanced: true as const,
    },
    explanation: {
      templateVersion: normalizedRules.explanationTemplateVersion,
      text: renderExplanation(lines),
    },
  }
  return fiscalCalculationOutcomeSchema.parse({
    ...withoutDigest,
    resultDigest: canonicalDigest(withoutDigest),
  })
}

function calculateLine(
  input: FiscalCalculationInput,
  line: FiscalCalculationInput['lines'][number],
  rules: readonly ResolvedComponentRule[],
  currencyMinorUnitScale: number,
): CalculatedLine {
  const scale = integer(10n ** BigInt(currencyMinorUnitScale))
  const grossRational = multiply(multiply(decimal(line.quantity), decimal(line.unitPrice)), scale)
  const gross = roundHalfAwayFromZero(grossRational)
  const net = gross - BigInt(line.discount.amount) + BigInt(line.charges.amount)
  const components = { legacy: [] as CalculatedComponent[], ibsCbs: [] as CalculatedComponent[] }
  for (const rule of rules)
    components[rule.group].push(calculateComponent(net, input.currency, rule))
  return {
    lineId: line.id,
    gross: money(gross, input.currency),
    net: money(net, input.currency),
    components,
  }
}

function calculateComponent(
  base: bigint,
  currency: string,
  rule: ResolvedComponentRule,
): CalculatedComponent {
  const rate = reduce({
    numerator: BigInt(rule.rate.numerator),
    denominator: BigInt(rule.rate.denominator),
  })
  const unrounded = multiply(integer(base), rate)
  return {
    code: rule.code,
    base: money(base, currency),
    rate: stringifyRational(rate),
    unrounded: { ...stringifyRational(unrounded), currency },
    amount: money(roundHalfAwayFromZero(unrounded), currency),
    formula: rule.formula,
    rounding: { mode: 'half-away-from-zero', scale: 0 },
    rule: rule.rule,
    source: {
      packageId: rule.source.packageId,
      digest: rule.source.digest,
      uri: rule.source.uri,
      section: rule.source.section,
    },
  }
}

function validateRules(
  input: FiscalCalculationInput,
  rules: ResolvedRuleSet,
  inputDigest: string,
): FiscalCalculationOutcome | null {
  if (
    !Number.isInteger(rules.currencyMinorUnitScale) ||
    rules.currencyMinorUnitScale < 0 ||
    rules.currencyMinorUnitScale > 6
  )
    return unsupported(
      'INVALID_FISCAL_INPUT',
      'Currency minor-unit scale is invalid',
      undefined,
      inputDigest,
    )
  const inputLineIds = new Set(input.lines.map((line) => line.id))
  const unexpectedLine = Object.keys(rules.lines).find((lineId) => !inputLineIds.has(lineId))
  if (unexpectedLine)
    return unsupported(
      'INVALID_FISCAL_INPUT',
      'Resolved rules contain an unexpected line',
      unexpectedLine,
      inputDigest,
    )
  for (const line of input.lines) {
    const lineRules = rules.lines[line.id]
    if (!lineRules || lineRules.length === 0)
      return unsupported(
        'UNSUPPORTED_RULE',
        'No approved rule matches this line',
        line.id,
        inputDigest,
      )
    const identities = new Set<string>()
    for (const rule of lineRules) {
      if (!rule.source.approved)
        return unsupported(
          'SOURCE_NOT_APPROVED',
          'A selected source has not been approved',
          rule.source.packageId,
          inputDigest,
        )
      const identity = `${rule.group}:${rule.code}`
      if (identities.has(identity))
        return unsupported(
          'AMBIGUOUS_RULE',
          'More than one rule selected the same component',
          identity,
          inputDigest,
        )
      identities.add(identity)
      if (!/^-?\d+$/.test(rule.rate.numerator) || !/^[1-9]\d*$/.test(rule.rate.denominator))
        return unsupported(
          'INVALID_FISCAL_INPUT',
          'A selected rate is invalid',
          identity,
          inputDigest,
        )
    }
  }
  return null
}

function normalizeInput(input: FiscalCalculationInput): FiscalCalculationInput {
  return {
    ...input,
    lines: [...input.lines].sort((left, right) => left.id.localeCompare(right.id)),
  }
}

function normalizeRules(rules: ResolvedRuleSet): ResolvedRuleSet {
  const lines: Record<string, readonly ResolvedComponentRule[]> = {}
  for (const lineId of Object.keys(rules.lines).sort())
    lines[lineId] = [...(rules.lines[lineId] ?? [])].sort((left, right) =>
      `${left.group}:${left.code}:${left.rule.id}`.localeCompare(
        `${right.group}:${right.code}:${right.rule.id}`,
      ),
    )
  return { ...rules, lines }
}

function unsupported(
  code: Exclude<FiscalCalculationOutcome, { supported: true }>['code'],
  detail: string,
  missingDimension?: string,
  inputDigest?: string,
): FiscalCalculationOutcome {
  return {
    schemaVersion: 1,
    supported: false,
    code,
    detail,
    ...(missingDimension ? { missingDimension } : {}),
    ...(inputDigest ? { inputDigest } : {}),
  }
}

function money(amount: bigint, currency: string) {
  return { amount: amount.toString(), currency }
}

function sum(values: readonly string[]): bigint {
  return values.reduce((total, value) => total + BigInt(value), 0n)
}

function findDuplicate(values: readonly string[]): string | undefined {
  const found = new Set<string>()
  for (const value of values) {
    if (found.has(value)) return value
    found.add(value)
  }
  return undefined
}

function stringifyRational(value: Rational) {
  return { numerator: value.numerator.toString(), denominator: value.denominator.toString() }
}

function renderExplanation(lines: readonly CalculatedLine[]): string {
  return lines
    .flatMap((line) => [
      `Line ${line.lineId}: net ${line.net.amount} ${line.net.currency} minor units.`,
      ...[...line.components.legacy, ...line.components.ibsCbs].map(
        (component) =>
          `${component.code}: ${component.base.amount} × ${component.rate.numerator}/${component.rate.denominator} = ${component.amount.amount}; rule ${component.rule.id} v${component.rule.version}; source ${component.source.uri} § ${component.source.section}.`,
      ),
    ])
    .join('\n')
}
