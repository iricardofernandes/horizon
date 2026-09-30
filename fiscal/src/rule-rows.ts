import { createHash } from 'node:crypto'
import type postgres from 'postgres'
import { z } from 'zod'
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
