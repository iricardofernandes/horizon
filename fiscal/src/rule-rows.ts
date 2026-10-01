import { createHash } from 'node:crypto'
import type { FiscalRuleSummary } from '@horizon/contracts'
import type postgres from 'postgres'
import { z } from 'zod'
import { canonicalDigest } from './canonical-json'
import { ruleExpressionSchema } from './formula'
import type { TaxRule } from './rules'

/** Rule and reference shapes, and their row mapping, shared by a workspace's store and the catalogue. */

const date = z.iso.date()
const digest = z.string().regex(/^[0-9a-f]{64}$/)

export const referenceEntrySchema = z.object({
  family: z.enum(['cfop', 'ncm', 'cest', 'cst', 'csosn', 'ibs_cbs', 'service', 'class_trib']),
  code: z.string().min(1).max(40),
  description: z.string().min(1).max(1000),
  model: z.enum(['*', '55', '65', 'nfse']).default('*'),
  jurisdiction: z.string().min(1).max(20).default('*'),
  effectiveFrom: date,
  effectiveTo: date.optional(),
  sourceLocator: z.string().min(1).max(300),
})

export const taxRuleImportSchema = z
  .object({
    ruleKey: z.string().min(1).max(120),
    version: z.int().positive(),
    group: z.enum(['legacy', 'ibsCbs']),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
    precedence: z.enum(['operation', 'establishment', 'item', 'party', 'default']),
    priority: z.int().nonnegative(),
    dateBasis: z.enum(['issue_date', 'competence_date']).default('issue_date'),
    model: z.enum(['55', '65', 'nfse']),
    environment: z.enum(['simulation', 'homologation', 'production']),
    operation: z.string().min(1).max(80).optional(),
    issuerEstablishmentId: z.uuid().optional(),
    issuerRegime: z.string().min(1).max(80).optional(),
    recipientPartyId: z.uuid().optional(),
    recipientRegime: z.string().min(1).max(80).optional(),
    originState: z
      .string()
      .regex(/^\d{2}$/)
      .optional(),
    destinationState: z
      .string()
      .regex(/^\d{2}$/)
      .optional(),
    recipientTaxpayer: z.boolean().optional(),
    issuerMunicipality: z
      .string()
      .regex(/^\d{7}$/)
      .optional(),
    issuerIncomeTaxRegime: z.enum(['lucro-real', 'lucro-presumido']).optional(),
    fact: z
      .object({
        key: z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/),
        value: z.string().min(1).max(80),
      })
      .optional(),
    subject: z.object({ kind: z.enum(['item', 'service']), id: z.uuid() }).optional(),
    classification: z
      .object({
        kind: z.enum(['ncm', 'cest', 'service', 'origin', 'class_trib']),
        code: z.string().min(1).max(40),
      })
      .optional(),
    effectiveFrom: date,
    effectiveTo: date.optional(),
    rate: z.object({
      numerator: z.string().regex(/^-?\d+$/),
      denominator: z.string().regex(/^[1-9]\d*$/),
    }),
    purpose: z.enum(['normal', 'return', 'complementary', 'adjustment']).default('normal'),
    formula: z.enum([
      'LINE_NET_TIMES_RATE',
      'DOCUMENT_NET_TIMES_RATE',
      'RETURN_LINE_NET_TIMES_RATE',
      'EXPRESSION',
    ]),
    /** How the base is built, when the formula is `EXPRESSION` (Phase 83, ADR 0071). */
    expression: ruleExpressionSchema.optional(),
    sourceLocator: z.string().min(1).max(300),
  })
  .superRefine((rule, context) => {
    if ((rule.formula === 'EXPRESSION') !== Boolean(rule.expression))
      context.addIssue({
        code: 'custom',
        path: ['expression'],
        message: 'an EXPRESSION formula carries an expression, and no other formula does',
      })
    const required =
      rule.precedence === 'operation'
        ? rule.operation
        : rule.precedence === 'establishment'
          ? rule.issuerEstablishmentId
          : rule.precedence === 'item'
            ? rule.subject?.id
            : rule.precedence === 'party'
              ? rule.recipientPartyId
              : 'default'
    if (!required)
      context.addIssue({
        code: 'custom',
        path: ['precedence'],
        message: `precedence ${rule.precedence} requires its exact scope dimension`,
      })
  })

export function deterministicUuid(...parts: string[]): string {
  const bytes = createHash('sha256').update(parts.join('\0')).digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function toTaxRule(row: postgres.Row): TaxRule {
  const optional = (value: unknown) => (value === '*' ? undefined : String(value))
  const operation = optional(row.operation)
  const issuerEstablishmentId = optional(row.issuer_establishment_id)
  const issuerRegime = optional(row.issuer_regime)
  const recipientPartyId = optional(row.recipient_party_id)
  const recipientRegime = optional(row.recipient_regime)
  const originState = optional(row.origin_state)
  const destinationState = optional(row.destination_state)
  const recipientTaxpayer = optional(row.recipient_taxpayer)
  const issuerMunicipality = optional(row.issuer_municipality)
  const issuerIncomeTaxRegime = optional(row.issuer_income_tax_regime) as
    | 'lucro-real'
    | 'lucro-presumido'
    | undefined
  const factKey = optional(row.fact_key)
  const subjectKind = optional(row.subject_kind)
  const classificationKind = optional(row.classification_kind)
  return {
    tenantId: String(row.tenant_id),
    group: row.component_group === 'ibs_cbs' ? 'ibsCbs' : 'legacy',
    code: String(row.component_code),
    precedence: row.precedence as TaxRule['precedence'],
    priority: Number(row.priority),
    dateBasis: row.date_basis as TaxRule['dateBasis'],
    effectiveFrom: String(row.effective_from),
    ...(row.effective_to ? { effectiveTo: String(row.effective_to) } : {}),
    active: row.action === 'activate',
    scope: {
      model: row.model as TaxRule['scope']['model'],
      environment: row.environment as TaxRule['scope']['environment'],
      purpose: row.purpose as TaxRule['scope']['purpose'],
      ...(operation ? { operation } : {}),
      ...(issuerEstablishmentId ? { issuerEstablishmentId } : {}),
      ...(issuerRegime ? { issuerRegime } : {}),
      ...(recipientPartyId ? { recipientPartyId } : {}),
      ...(recipientRegime ? { recipientRegime } : {}),
      ...(originState ? { originState } : {}),
      ...(destinationState ? { destinationState } : {}),
      ...(recipientTaxpayer ? { recipientTaxpayer: recipientTaxpayer === 'true' } : {}),
      ...(issuerMunicipality ? { issuerMunicipality } : {}),
      ...(issuerIncomeTaxRegime ? { issuerIncomeTaxRegime } : {}),
      ...(factKey ? { fact: { key: factKey, value: String(row.fact_value) } } : {}),
      ...(subjectKind
        ? { subject: { kind: subjectKind as 'item' | 'service', id: String(row.subject_id) } }
        : {}),
      ...(classificationKind
        ? {
            classification: {
              kind: classificationKind as NonNullable<TaxRule['scope']['classification']>['kind'],
              code: String(row.classification_code),
            },
          }
        : {}),
    },
    rate: { numerator: String(row.rate_numerator), denominator: String(row.rate_denominator) },
    formula: row.formula as TaxRule['formula'],
    ...(row.expression ? { expression: ruleExpressionSchema.parse(row.expression) } : {}),
    rule: { id: String(row.id), version: Number(row.version) },
    source: {
      packageId: String(row.package_id),
      digest: digest.parse(row.package_digest),
      uri: String(row.source_uri),
      section: String(row.source_locator),
      approved: row.approved === true,
    },
  }
}

export type TaxRuleImport = z.infer<typeof taxRuleImportSchema>

/**
 * The stored row of an imported rule, column by column, as the workspace's store writes it.
 * The impact report reads a rule that is not stored yet through the same mapping (Phase 88).
 */
export function ruleRowOf(
  tenantId: string,
  packageId: string,
  id: string,
  rule: TaxRuleImport,
): Record<string, unknown> {
  return {
    id,
    tenant_id: tenantId,
    package_id: packageId,
    rule_key: rule.ruleKey,
    version: rule.version,
    component_group: rule.group === 'ibsCbs' ? 'ibs_cbs' : 'legacy',
    component_code: rule.code,
    precedence: rule.precedence,
    priority: rule.priority,
    date_basis: rule.dateBasis,
    purpose: rule.purpose,
    model: rule.model,
    environment: rule.environment,
    operation: rule.operation ?? '*',
    issuer_establishment_id: rule.issuerEstablishmentId ?? '*',
    issuer_regime: rule.issuerRegime ?? '*',
    recipient_party_id: rule.recipientPartyId ?? '*',
    recipient_regime: rule.recipientRegime ?? '*',
    origin_state: rule.originState ?? '*',
    destination_state: rule.destinationState ?? '*',
    subject_kind: rule.subject?.kind ?? '*',
    subject_id: rule.subject?.id ?? '*',
    classification_kind: rule.classification?.kind ?? '*',
    classification_code: rule.classification?.code ?? '*',
    recipient_taxpayer: rule.recipientTaxpayer === undefined ? '*' : String(rule.recipientTaxpayer),
    issuer_municipality: rule.issuerMunicipality ?? '*',
    fact_key: rule.fact?.key ?? '*',
    fact_value: rule.fact?.value ?? '*',
    issuer_income_tax_regime: rule.issuerIncomeTaxRegime ?? '*',
    effective_from: rule.effectiveFrom,
    effective_to: rule.effectiveTo ?? null,
    rate_numerator: rule.rate.numerator,
    rate_denominator: rule.rate.denominator,
    formula: rule.formula,
    expression: rule.expression ?? null,
    source_locator: rule.sourceLocator,
    definition_digest: canonicalDigest(rule),
  }
}

/** The scope columns a summary lists when they constrain the rule. */
const SCOPE_COLUMNS = {
  operation: 'operation',
  issuerEstablishmentId: 'issuer_establishment_id',
  issuerRegime: 'issuer_regime',
  issuerIncomeTaxRegime: 'issuer_income_tax_regime',
  issuerMunicipality: 'issuer_municipality',
  recipientPartyId: 'recipient_party_id',
  recipientRegime: 'recipient_regime',
  recipientTaxpayer: 'recipient_taxpayer',
  originState: 'origin_state',
  destinationState: 'destination_state',
  subjectKind: 'subject_kind',
  subjectId: 'subject_id',
  classificationKind: 'classification_kind',
  classificationCode: 'classification_code',
  factKey: 'fact_key',
  factValue: 'fact_value',
} as const

/** A stored rule, of the catalogue or of a workspace, as the governance screens show it. */
export function ruleSummaryOf(row: postgres.Row | Record<string, unknown>): FiscalRuleSummary {
  const scope: Record<string, string> = {}
  for (const [name, column] of Object.entries(SCOPE_COLUMNS)) {
    const value = row[column]
    if (value !== undefined && value !== null && value !== '*') scope[name] = String(value)
  }
  const dateOf = (value: unknown) =>
    value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
  return {
    id: String(row.id),
    ruleKey: String(row.rule_key),
    version: Number(row.version),
    group: row.component_group === 'ibs_cbs' ? 'ibsCbs' : 'legacy',
    code: String(row.component_code),
    precedence: row.precedence as FiscalRuleSummary['precedence'],
    priority: Number(row.priority),
    model: row.model as FiscalRuleSummary['model'],
    environment: row.environment as FiscalRuleSummary['environment'],
    purpose: row.purpose as FiscalRuleSummary['purpose'],
    scope,
    effectiveFrom: dateOf(row.effective_from),
    effectiveTo: row.effective_to ? dateOf(row.effective_to) : null,
    rate: { numerator: String(row.rate_numerator), denominator: String(row.rate_denominator) },
    formula: String(row.formula),
    expression: row.expression ?? null,
    sourceLocator: String(row.source_locator),
    definitionDigest: String(row.definition_digest),
  }
}
