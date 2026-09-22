import type { FiscalCalculationInput, FiscalCalculationProblemCode } from '@horizon/contracts'
import type { ResolvedComponentRule, ResolvedRuleSet } from './calculation'

export type TaxRule = ResolvedComponentRule & {
  tenantId: string
  precedence: 'operation' | 'establishment' | 'item' | 'party' | 'default'
  priority: number
  dateBasis: 'issue_date' | 'competence_date'
  effectiveFrom: string
  effectiveTo?: string
  active: boolean
  scope: {
    model: FiscalCalculationInput['model']
    environment: FiscalCalculationInput['environment']
    purpose: FiscalCalculationInput['purpose']
    operation?: string
    issuerEstablishmentId?: string
    issuerRegime?: string
    recipientRegime?: string
    originState?: string
    destinationState?: string
    subject?: { kind: 'item' | 'service'; id: string }
    classification?: { kind: 'ncm' | 'cest' | 'service' | 'origin'; code: string }
  }
}

export type ResolutionTrace = {
  lineId: string
  component: string
  consideredRuleIds: string[]
  selectedRuleId: string
  precedence: TaxRule['precedence']
  priority: number
  rejectedRuleIds: string[]
}

export type RuleResolution =
  | { supported: true; rules: ResolvedRuleSet; trace: ResolutionTrace[] }
  | {
      supported: false
      code: FiscalCalculationProblemCode
      detail: string
      missingDimension?: string
    }

const precedenceRank: Record<TaxRule['precedence'], number> = {
  operation: 5,
  establishment: 4,
  item: 3,
  party: 2,
  default: 1,
}

export function resolveTaxRules(
  input: FiscalCalculationInput,
  candidates: readonly TaxRule[],
  currencyMinorUnitScale: number,
): RuleResolution {
  const tenantCandidates = candidates.filter((rule) => rule.tenantId === input.tenantId)
  const lines: Record<string, ResolvedComponentRule[]> = {}
  const trace: ResolutionTrace[] = []
  for (const line of [...input.lines].sort((left, right) => left.id.localeCompare(right.id))) {
    const scoped = tenantCandidates.filter((rule) => matches(rule, input, line))
    const componentKeys = [...new Set(scoped.map((rule) => `${rule.group}:${rule.code}`))].sort()
    if (componentKeys.length === 0)
      return {
        supported: false,
        code: missingClassification(line) ? 'MISSING_CLASSIFICATION' : 'UNSUPPORTED_RULE',
        detail: 'No effective active rule matches this fiscal line',
        missingDimension: line.id,
      }
    const selectedRules: ResolvedComponentRule[] = []
    lines[line.id] = selectedRules
    for (const component of componentKeys) {
      const matching = scoped.filter((rule) => `${rule.group}:${rule.code}` === component)
      const approved = matching.filter((rule) => rule.source.approved)
      if (approved.length === 0)
        return {
          supported: false,
          code: 'SOURCE_NOT_APPROVED',
          detail: 'Every matching rule for a component has an unapproved source',
          missingDimension: component,
        }
      const highestRank = Math.max(...approved.map((rule) => precedenceRank[rule.precedence]))
      const mostSpecific = approved.filter(
        (rule) => precedenceRank[rule.precedence] === highestRank,
      )
      const highestPriority = Math.max(...mostSpecific.map((rule) => rule.priority))
      const winners = mostSpecific.filter((rule) => rule.priority === highestPriority)
      if (winners.length !== 1)
        return {
          supported: false,
          code: 'AMBIGUOUS_RULE',
          detail: 'Equal-precedence and equal-priority rules match the same component',
          missingDimension: component,
        }
      const winner = winners[0]
      if (!winner) throw new Error('Rule resolution invariant failed')
      selectedRules.push(toResolvedRule(winner))
      trace.push({
        lineId: line.id,
        component,
        consideredRuleIds: matching.map((rule) => rule.rule.id).sort(),
        selectedRuleId: winner.rule.id,
        precedence: winner.precedence,
        priority: winner.priority,
        rejectedRuleIds: matching
          .filter((rule) => rule.rule.id !== winner.rule.id)
          .map((rule) => rule.rule.id)
          .sort(),
      })
    }
  }
  return {
    supported: true,
    rules: {
      schemaVersion: 1,
      currencyMinorUnitScale,
      explanationTemplateVersion: 'fiscal-explanation-v1',
      lines,
    },
    trace,
  }
}

function matches(
  rule: TaxRule,
  input: FiscalCalculationInput,
  line: FiscalCalculationInput['lines'][number],
): boolean {
  const selectionDate =
    rule.dateBasis === 'competence_date' ? input.competenceDate : input.issueDate
  if (!selectionDate || !rule.active || selectionDate < rule.effectiveFrom) return false
  if (rule.effectiveTo && selectionDate >= rule.effectiveTo) return false
  const scope = rule.scope
  if (scope.model !== input.model || scope.environment !== input.environment) return false
  if (scope.purpose !== input.purpose) return false
  if (scope.operation && scope.operation !== input.operation) return false
  if (scope.issuerEstablishmentId && scope.issuerEstablishmentId !== input.issuerEstablishmentId)
    return false
  if (scope.issuerRegime && scope.issuerRegime !== input.issuer.regime) return false
  if (scope.recipientRegime && scope.recipientRegime !== input.recipient.regime) return false
  if (scope.originState && scope.originState !== input.origin.stateCode) return false
  if (scope.destinationState && scope.destinationState !== input.destination.stateCode) return false
  if (scope.subject) {
    const subjectId = scope.subject.kind === 'item' ? line.itemId : line.serviceId
    if (subjectId !== scope.subject.id) return false
  }
  if (
    scope.classification &&
    line.classifications[scope.classification.kind] !== scope.classification.code
  )
    return false
  return true
}

function missingClassification(line: FiscalCalculationInput['lines'][number]): boolean {
  return line.itemId ? !line.classifications.ncm : !line.classifications.service
}

function toResolvedRule(rule: TaxRule): ResolvedComponentRule {
  return {
    group: rule.group,
    code: rule.code,
    rate: rule.rate,
    formula: rule.formula,
    rule: rule.rule,
    source: rule.source,
  }
}
