import { z } from 'zod'
import {
  add,
  compare,
  decimal,
  divide,
  integer,
  multiply,
  type Rational,
  reduce,
  roundHalfAwayFromZero,
  roundHalfEven,
  subtract,
} from './exact-decimal'

/**
 * The formula language of tax rules (Phase 83, ADR 0071): an expression builds a component's
 * base from the line and from other components, over a closed vocabulary with no code, no
 * loop and no conditional. The rule's rate then applies to the base.
 */
export const FORMULA_VERSION = 'formula-v1'
export const MAX_DEPTH = 8
export const MAX_NODES = 64

const rationalSchema = z.object({
  numerator: z.string().regex(/^-?\d+$/),
  denominator: z.string().regex(/^[1-9]\d*$/),
})

export const LINE_VALUES = ['gross', 'discount', 'charges', 'net', 'quantity'] as const
export type LineValue = (typeof LINE_VALUES)[number]

export type Expression =
  | { line: LineValue }
  | { component: string }
  | { rate: { numerator: string; denominator: string } }
  | { sum: Expression[] }
  | { product: Expression[] }
  | { grossUp: { base: Expression; rate: Expression } }
  | { reduce: { base: Expression; by: Expression } }
  | { difference: [Expression, Expression] }
  | { min: Expression[] }
  | { max: Expression[] }

const operands = (node: z.ZodType<Expression>) => z.array(node).min(2).max(8)

export const expressionSchema: z.ZodType<Expression> = z.lazy(() =>
  z.union([
    z.strictObject({ line: z.enum(LINE_VALUES) }),
    z.strictObject({ component: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/) }),
    z.strictObject({ rate: rationalSchema }),
    z.strictObject({ sum: operands(expressionSchema) }),
    z.strictObject({ product: operands(expressionSchema) }),
    z.strictObject({
      grossUp: z.strictObject({ base: expressionSchema, rate: expressionSchema }),
    }),
    z.strictObject({ reduce: z.strictObject({ base: expressionSchema, by: expressionSchema }) }),
    // Phase 85: the revenue less the ICMS charged on it, for PIS/Cofins.
    z.strictObject({ difference: z.tuple([expressionSchema, expressionSchema]) }),
    z.strictObject({ min: operands(expressionSchema) }),
    z.strictObject({ max: operands(expressionSchema) }),
  ]),
)

export const OUTCOMES = ['levied', 'exempt', 'suspended', 'deferred', 'not-levied'] as const
export type Outcome = (typeof OUTCOMES)[number]

export const ruleExpressionSchema = z
  .strictObject({
    version: z.literal(FORMULA_VERSION),
    base: expressionSchema,
    outcome: z.enum(OUTCOMES).default('levied'),
    /** Absent means half away from zero, as Phase 41; the reform's packages use half-even. */
    rounding: z.enum(['half-away-from-zero', 'half-even']).optional(),
    /**
     * Components subtracted from the rounded amount, never below zero (Phase 85): ICMS-ST is
     * the tax at the destination's rate less the own-operation ICMS (LC 87/1996 art. 8º §5º).
     */
    deduct: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/))
      .min(1)
      .max(4)
      .optional(),
  })
  .superRefine((value, context) => {
    const problem = sizeProblem(value.base)
    if (problem) context.addIssue({ code: 'custom', path: ['base'], message: problem })
  })

export type RuleExpression = z.infer<typeof ruleExpressionSchema>

/** The operands of a node, and whether it is a leaf. */
function children(expression: Expression): Expression[] {
  if ('sum' in expression) return expression.sum
  if ('product' in expression) return expression.product
  if ('min' in expression) return expression.min
  if ('max' in expression) return expression.max
  if ('grossUp' in expression) return [expression.grossUp.base, expression.grossUp.rate]
  if ('reduce' in expression) return [expression.reduce.base, expression.reduce.by]
  if ('difference' in expression) return expression.difference
  return []
}

export function sizeProblem(expression: Expression): string | null {
  let nodes = 0
  const walk = (node: Expression, depth: number): string | null => {
    nodes += 1
    if (depth > MAX_DEPTH) return `an expression is at most ${MAX_DEPTH} levels deep`
    if (nodes > MAX_NODES) return `an expression has at most ${MAX_NODES} nodes`
    for (const child of children(node)) {
      const problem = walk(child, depth + 1)
      if (problem) return problem
    }
    return null
  }
  return walk(expression, 1)
}

/** The components an expression reads. */
export function references(expression: Expression): string[] {
  if ('component' in expression) return [expression.component]
  return [...new Set(children(expression).flatMap(references))].sort()
}

/** The components a rule's expression reads: in its base, and those it deducts. */
export function ruleReferences(expression: RuleExpression): string[] {
  return [...new Set([...references(expression.base), ...(expression.deduct ?? [])])].sort()
}

/**
 * Checked when a package is published or imported: every referenced component is defined by
 * some rule of the package, and the references form no cycle.
 */
export function packageProblem(
  rules: readonly { code: string; expression?: RuleExpression | undefined }[],
  /** Components the package reads from other packages (Phase 86); absent at calculation, unsupported. */
  requires: readonly string[] = [],
): string | null {
  const defined = new Set(rules.map((rule) => rule.code))
  const required = new Set(requires)
  for (const code of required)
    if (defined.has(code)) return `${code} is both defined and required by the package`
  const edges = new Map<string, Set<string>>()
  for (const rule of rules) {
    if (!rule.expression) continue
    for (const reference of ruleReferences(rule.expression)) {
      if (required.has(reference)) continue
      if (!defined.has(reference))
        return `${rule.code} reads component ${reference}, which no rule of the package defines`
      if (reference === rule.code) return `${rule.code} reads itself`
      const set = edges.get(rule.code) ?? new Set<string>()
      set.add(reference)
      edges.set(rule.code, set)
    }
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (code: string, path: string[]): string | null => {
    if (state.get(code) === 'done') return null
    if (state.get(code) === 'visiting')
      return `components depend on each other in a cycle: ${[...path, code].join(' → ')}`
    state.set(code, 'visiting')
    for (const next of edges.get(code) ?? []) {
      const problem = visit(next, [...path, code])
      if (problem) return problem
    }
    state.set(code, 'done')
    return null
  }
  for (const code of [...edges.keys()].sort()) {
    const problem = visit(code, [])
    if (problem) return problem
  }
  return null
}

/** The order to evaluate a line's components in: each after the ones it reads. */
export function evaluationOrder<
  T extends { code: string; expression?: RuleExpression | undefined },
>(rules: readonly T[]): { order: T[] } | { missing: string } {
  const byCode = new Map(rules.map((rule) => [rule.code, rule]))
  const ordered: T[] = []
  const placed = new Set<string>()
  const place = (rule: T, trail: Set<string>): string | null => {
    if (placed.has(rule.code)) return null
    if (trail.has(rule.code)) throw new Error('A cycle reached evaluation; packages are checked')
    trail.add(rule.code)
    for (const reference of rule.expression ? ruleReferences(rule.expression) : []) {
      const dependency = byCode.get(reference)
      if (!dependency) return reference
      const missing = place(dependency, trail)
      if (missing) return missing
    }
    trail.delete(rule.code)
    placed.add(rule.code)
    ordered.push(rule)
    return null
  }
  for (const rule of [...rules].sort((left, right) => left.code.localeCompare(right.code))) {
    const missing = place(rule, new Set())
    if (missing) return { missing }
  }
  return { order: ordered }
}

export type LineValues = Readonly<Record<LineValue, Rational>>

export type Step = { step: string; value: Rational }

/** The value of an expression over a line and the components already computed on it. */
export function evaluate(
  expression: Expression,
  line: LineValues,
  components: ReadonlyMap<string, bigint>,
): Rational {
  if ('line' in expression) return line[expression.line]
  if ('component' in expression) {
    const amount = components.get(expression.component)
    if (amount === undefined) throw new Error(`component ${expression.component} is not computed`)
    return integer(amount)
  }
  if ('rate' in expression)
    return reduce({
      numerator: BigInt(expression.rate.numerator),
      denominator: BigInt(expression.rate.denominator),
    })
  const values = children(expression).map((child) => evaluate(child, line, components))
  if ('sum' in expression) return values.reduce(add)
  if ('product' in expression) return values.reduce(multiply)
  if ('min' in expression) return values.reduce((a, b) => (compare(a, b) <= 0 ? a : b))
  if ('max' in expression) return values.reduce((a, b) => (compare(a, b) >= 0 ? a : b))
  const [base, rate] = values as [Rational, Rational]
  if ('difference' in expression) return subtract(base, rate)
  if ('grossUp' in expression) {
    const remainder = subtract(integer(1n), rate)
    if (compare(remainder, integer(0n)) <= 0) throw new Error('A gross-up rate must be below one')
    return divide(base, remainder)
  }
  return multiply(base, subtract(integer(1n), rate))
}

/**
 * A component's base and amount: the base rounded to the minor unit, then taxed at the rule's
 * rate and rounded again. An outcome other than `levied` keeps the base and owes nothing.
 */
export function evaluateComponent(
  expression: RuleExpression,
  rate: Rational,
  line: LineValues,
  components: ReadonlyMap<string, bigint>,
): {
  base: bigint
  unrounded: Rational
  amount: bigint
  outcome: Outcome
  rounding: 'half-away-from-zero' | 'half-even'
  steps: Step[]
} {
  const rounding = expression.rounding ?? 'half-away-from-zero'
  const round = rounding === 'half-even' ? roundHalfEven : roundHalfAwayFromZero
  const roundedAs = rounding === 'half-even' ? 'half to even' : 'half away from zero'
  const baseValue = evaluate(expression.base, line, components)
  const base = round(baseValue)
  const levied = expression.outcome === 'levied'
  const taxed = levied ? multiply(integer(base), rate) : integer(0n)
  const rounded = round(taxed)
  const deductions = levied
    ? (expression.deduct ?? []).map((code) => {
        const amount = components.get(code)
        if (amount === undefined) throw new Error(`component ${code} is not computed`)
        return { code, amount }
      })
    : []
  const deducted = deductions.reduce((total, deduction) => total + deduction.amount, 0n)
  const amount = rounded - deducted > 0n ? rounded - deducted : 0n
  const steps: Step[] = [
    { step: `base = ${render(expression.base)}`, value: baseValue },
    { step: `base, rounded ${roundedAs}`, value: integer(base) },
    { step: 'rate', value: rate },
    { step: levied ? 'base × rate' : `${expression.outcome}: nothing is owed`, value: taxed },
    { step: `amount, rounded ${roundedAs}`, value: integer(rounded) },
  ]
  for (const deduction of deductions)
    steps.push({ step: `less ${deduction.code}`, value: integer(-deduction.amount) })
  if (deductions.length > 0)
    steps.push({ step: 'amount due, never below zero', value: integer(amount) })
  return {
    base,
    unrounded: deductions.length > 0 ? subtract(taxed, integer(deducted)) : taxed,
    amount,
    outcome: expression.outcome,
    rounding,
    steps,
  }
}

/** An expression as a person reads it. */
export function render(expression: Expression): string {
  if ('line' in expression) return `line.${expression.line}`
  if ('component' in expression) return expression.component
  if ('rate' in expression) return `${expression.rate.numerator}/${expression.rate.denominator}`
  if ('sum' in expression) return `(${expression.sum.map(render).join(' + ')})`
  if ('product' in expression) return `(${expression.product.map(render).join(' × ')})`
  if ('min' in expression) return `min(${expression.min.map(render).join(', ')})`
  if ('max' in expression) return `max(${expression.max.map(render).join(', ')})`
  if ('difference' in expression)
    return `(${render(expression.difference[0])} − ${render(expression.difference[1])})`
  if ('grossUp' in expression)
    return `grossUp(${render(expression.grossUp.base)}, ${render(expression.grossUp.rate)})`
  return `reduce(${render(expression.reduce.base)}, ${render(expression.reduce.by)})`
}

/** A line's values as rationals, in minor units except the quantity. */
export function lineValues(values: {
  gross: bigint
  discount: bigint
  charges: bigint
  net: bigint
  quantity: string
}): LineValues {
  return {
    gross: integer(values.gross),
    discount: integer(values.discount),
    charges: integer(values.charges),
    net: integer(values.net),
    quantity: decimal(values.quantity),
  }
}
