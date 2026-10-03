import {
  businessDayOf,
  FISCAL_IMPACT_DOCUMENT_LIMIT,
  FISCAL_IMPACT_MONTHS_DEFAULT,
  type FiscalCalculationInput,
  type FiscalCalculationResult,
  type FiscalRuleImpact,
  type FiscalTaxSupportMatrix,
  fiscalCalculationInputSchema,
} from '@horizon/contracts'
import type postgres from 'postgres'
import { calculateFiscal } from './calculation'
import { openCalculationInput } from './calculation-crypto'
import { currencyScale, parseStoredResult } from './calculations'
import { canonicalDigest } from './canonical-json'
import { overlaid, type RuleOverlay, type RuleSet, resolveAgainst } from './rule-store'
import { scenarioSupport } from './tax-support'

type Changed = FiscalRuleImpact['changed'][number]
type Unsupported = FiscalRuleImpact['unsupported'][number]

/**
 * What a rule change would do to the workspace's locked documents (Phase 88, ADR 0074): each
 * calculation locked in the window is recalculated from its sealed input with the change in
 * force over the whole window, never locked, and compared component by component.
 */
export async function ruleImpact(input: {
  tx: postgres.TransactionSql
  masterKey: Buffer
  tenantId: string
  ruleSet: (model: string, environment: string) => Promise<RuleSet>
  overlay: RuleOverlay
  supportMatrix: FiscalTaxSupportMatrix | 'unchecked'
  months?: number | undefined
  now: Date
}): Promise<FiscalRuleImpact> {
  const months = input.months ?? FISCAL_IMPACT_MONTHS_DEFAULT
  const to = businessDayOf(input.now)
  const start = new Date(input.now)
  start.setUTCMonth(start.getUTCMonth() - months)
  const from = start.toISOString().slice(0, 10)
  const rows = await input.tx`select calculation.id, binding.document_id,
      calculation.input_ciphertext, calculation.input_digest, calculation.result_bytes
    from fiscal_document_calculation_bindings binding
    join fiscal_calculations calculation on calculation.tenant_id = binding.tenant_id
      and calculation.id = binding.calculation_id
    where binding.tenant_id = ${input.tenantId} and calculation.supported
      and calculation.created_at >= ${from}::date
    order by calculation.created_at desc, calculation.id
    limit ${FISCAL_IMPACT_DOCUMENT_LIMIT + 1}`
  const truncated = rows.length > FISCAL_IMPACT_DOCUMENT_LIMIT
  const sets = new Map<string, RuleSet>()
  const changed: Changed[] = []
  const unsupported: Unsupported[] = []
  let unchanged = 0
  for (const row of rows.slice(0, FISCAL_IMPACT_DOCUMENT_LIMIT)) {
    const calculationInput = fiscalCalculationInputSchema.parse(
      JSON.parse(
        openCalculationInput(
          input.masterKey,
          input.tenantId,
          String(row.id),
          Buffer.from(row.input_ciphertext),
        ),
      ),
    )
    const stored = parseStoredResult(row.result_bytes)
    const key = `${calculationInput.model}:${calculationInput.environment}`
    let set = sets.get(key)
    if (!set) {
      set = overlaid(
        await input.ruleSet(calculationInput.model, calculationInput.environment),
        input.overlay,
        calculationInput.model,
        calculationInput.environment,
      )
      sets.set(key, set)
    }
    const documentId = String(row.document_id)
    const issueDate = calculationInput.issueDate
    const outcome = recalculate(calculationInput, set)
    if (!outcome.supported) {
      unsupported.push({ documentId, issueDate, code: outcome.code, detail: outcome.detail })
      continue
    }
    const refused = newlyRefused(input.supportMatrix, calculationInput, stored, outcome.result)
    if (refused) {
      unsupported.push({ documentId, issueDate, code: 'UNSUPPORTED_SCENARIO', detail: refused })
      continue
    }
    const components = differences(stored, outcome.result)
    if (components.length === 0) unchanged += 1
    else changed.push({ documentId, issueDate, model: calculationInput.model, components })
  }
  const report = {
    months,
    from,
    to,
    examined: Math.min(rows.length, FISCAL_IMPACT_DOCUMENT_LIMIT),
    truncated,
    unchanged,
    changed,
    unsupported,
  }
  return { ...report, digest: canonicalDigest(report) }
}

function recalculate(
  input: FiscalCalculationInput,
  set: RuleSet,
):
  | { supported: true; result: FiscalCalculationResult }
  | { supported: false; code: string; detail: string } {
  const scale = currencyScale(input.currency)
  if (scale === null)
    return { supported: false, code: 'INVALID_FISCAL_INPUT', detail: 'Unsupported currency' }
  const resolution = resolveAgainst(input, set, scale)
  if (!resolution.supported)
    return { supported: false, code: resolution.code, detail: resolution.detail }
  const result = calculateFiscal(input, resolution.rules)
  if (!result.supported) return { supported: false, code: result.code, detail: result.detail }
  return { supported: true, result }
}

/** The matrix refusing what it covered before; a scenario it never covered is not news. */
function newlyRefused(
  matrix: FiscalTaxSupportMatrix | 'unchecked',
  input: FiscalCalculationInput,
  before: FiscalCalculationResult,
  after: FiscalCalculationResult,
): string | null {
  if (matrix === 'unchecked') return null
  if (!scenarioSupport(matrix, input, before).supported) return null
  const now = scenarioSupport(matrix, input, after)
  return now.supported ? null : now.detail
}

function totals(result: FiscalCalculationResult): Map<string, bigint> {
  const sums = new Map<string, bigint>()
  for (const line of result.lines)
    for (const component of [...line.components.legacy, ...line.components.ibsCbs])
      sums.set(component.code, (sums.get(component.code) ?? 0n) + BigInt(component.amount.amount))
  return sums
}

function differences(
  before: FiscalCalculationResult,
  after: FiscalCalculationResult,
): Changed['components'] {
  const was = totals(before)
  const is = totals(after)
  return [...new Set([...was.keys(), ...is.keys()])]
    .sort()
    .map((code) => {
      const old = was.get(code) ?? 0n
      const next = is.get(code) ?? 0n
      return {
        code,
        before: String(old),
        after: String(next),
        difference: String(next - old),
      }
    })
    .filter((component) => component.difference !== '0')
}
