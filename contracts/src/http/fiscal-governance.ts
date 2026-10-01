import { z } from 'zod'

import { dateSchema, instantSchema, uuidSchema } from '../common'

/**
 * Governing the tax rules (Phase 88, ADR 0074): the catalogue a workspace reads, the diff of a
 * change against what it calculates with today, the impact of that change on its locked
 * documents, and the request another person approves.
 */

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const componentCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/)
const minorSchema = z.string().regex(/^-?\d+$/)
const reasonSchema = z.string().trim().min(10).max(1000)

/** One rule as the screens show it; the scope lists only the dimensions it constrains. */
export const fiscalRuleSummarySchema = z.object({
  id: uuidSchema,
  ruleKey: z.string().min(1).max(120),
  version: z.int().positive(),
  group: z.enum(['legacy', 'ibsCbs']),
  code: componentCodeSchema,
  precedence: z.enum(['operation', 'establishment', 'item', 'party', 'default']),
  priority: z.int().nonnegative(),
  model: z.enum(['55', '65', 'nfse']),
  environment: z.enum(['simulation', 'homologation', 'production']),
  purpose: z.enum(['normal', 'return', 'complementary', 'adjustment']),
  scope: z.record(z.string(), z.string()),
  effectiveFrom: dateSchema,
  effectiveTo: dateSchema.nullable(),
  rate: z.object({
    numerator: z.string().regex(/^-?\d+$/),
    denominator: z.string().regex(/^[1-9]\d*$/),
  }),
  formula: z.string().min(1).max(60),
  /** The expression of an `EXPRESSION` rule, as stored (ADR 0071). */
  expression: z.unknown().nullable(),
  sourceLocator: z.string().min(1).max(300),
  definitionDigest: digestSchema,
})

export type FiscalRuleSummary = z.infer<typeof fiscalRuleSummarySchema>

export const fiscalPackageAdoptionStateSchema = z.object({
  state: z.enum(['adopted', 'withdrawn', 'never']),
  effectiveFrom: dateSchema.nullable(),
  decidedAt: instantSchema.nullable(),
})

/** A catalogue package and what this workspace did with it. */
export const fiscalCatalogPackageSchema = z.object({
  id: uuidSchema,
  authority: z.string().min(1).max(200),
  sourceUri: z.url(),
  packageDigest: digestSchema,
  publishedAt: dateSchema,
  effectiveFrom: dateSchema,
  publisher: z.string().min(1).max(200),
  ruleCount: z.int().nonnegative(),
  referenceCount: z.int().nonnegative(),
  components: z.array(componentCodeSchema).max(64),
  adoption: fiscalPackageAdoptionStateSchema,
  /** A pending request about this package; no other can be made beside it. */
  pendingChangeId: uuidSchema.nullable(),
})

export type FiscalCatalogPackage = z.infer<typeof fiscalCatalogPackageSchema>

export const fiscalCatalogPackageListSchema = z.object({
  data: z.array(fiscalCatalogPackageSchema),
})

/** A workspace's own rule: approved through its review, active through its last event. */
export const fiscalWorkspaceRuleSchema = fiscalRuleSummarySchema.extend({
  packageId: uuidSchema,
  approved: z.boolean(),
  active: z.boolean(),
})

export const fiscalWorkspaceRuleListSchema = z.object({
  data: z.array(fiscalWorkspaceRuleSchema),
})

export const FISCAL_RULE_DIFF_CHANGES = ['added', 'ended', 'changed', 'unchanged'] as const

/**
 * What a change does to the rules, key by key, from `before` (today, or another package) to
 * `after`. A key only before is ended; a key only after is added.
 */
export const fiscalRuleDiffSchema = z.object({
  against: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('workspace') }),
    z.object({ kind: z.literal('package'), packageId: uuidSchema }),
  ]),
  entries: z.array(
    z.object({
      ruleKey: z.string().min(1).max(120),
      change: z.enum(FISCAL_RULE_DIFF_CHANGES),
      before: fiscalRuleSummarySchema.nullable(),
      after: fiscalRuleSummarySchema.nullable(),
      fields: z.array(
        z.object({
          field: z.string().min(1).max(60),
          before: z.unknown(),
          after: z.unknown(),
        }),
      ),
    }),
  ),
  counts: z.object({
    added: z.int().nonnegative(),
    ended: z.int().nonnegative(),
    changed: z.int().nonnegative(),
    unchanged: z.int().nonnegative(),
  }),
})

export type FiscalRuleDiff = z.infer<typeof fiscalRuleDiffSchema>

/** How far back the impact report recalculates, in months. */
export const FISCAL_IMPACT_MONTHS_DEFAULT = 3
export const FISCAL_IMPACT_MONTHS_MAX = 12
/** The most locked calculations one report reads, newest first. */
export const FISCAL_IMPACT_DOCUMENT_LIMIT = 2000

/**
 * The locked documents of the window recalculated with the change in force over all of it,
 * never locked: those whose amounts would change, and those that would no longer calculate.
 */
export const fiscalRuleImpactSchema = z.object({
  months: z.int().min(1).max(FISCAL_IMPACT_MONTHS_MAX),
  from: dateSchema,
  to: dateSchema,
  examined: z.int().nonnegative(),
  truncated: z.boolean(),
  unchanged: z.int().nonnegative(),
  changed: z.array(
    z.object({
      documentId: uuidSchema,
      issueDate: dateSchema,
      model: z.enum(['55', '65', 'nfse']),
      components: z
        .array(
          z.object({
            code: componentCodeSchema,
            before: minorSchema,
            after: minorSchema,
            difference: minorSchema,
          }),
        )
        .min(1),
    }),
  ),
  unsupported: z.array(
    z.object({
      documentId: uuidSchema,
      issueDate: dateSchema,
      code: z.string().min(1).max(60),
      detail: z.string().min(1).max(1000),
    }),
  ),
  digest: digestSchema,
})

export type FiscalRuleImpact = z.infer<typeof fiscalRuleImpactSchema>

const impactMonthsSchema = z.int().min(1).max(FISCAL_IMPACT_MONTHS_MAX).optional()

/**
 * `POST /fiscal/rule-changes`. A workspace rule's `definition` is the rule as Fiscal imports
 * it (`ruleKey`, scope, rate, formula and expression); Fiscal validates it, and refuses a
 * catalogue-level precedence (`default`), which only the catalogue publishes.
 */
export const fiscalRuleChangeRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('adopt-package'),
      packageId: uuidSchema,
      effectiveFrom: dateSchema,
      interpretation: z.string().trim().min(1).max(4000),
      fixtureIds: z.array(z.string().min(1).max(200)).max(1000).default([]),
      reason: reasonSchema,
      impactMonths: impactMonthsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('withdraw-package'),
      packageId: uuidSchema,
      reason: reasonSchema,
      impactMonths: impactMonthsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('add-rule'),
      definition: z.record(z.string(), z.unknown()),
      sourceBasis: z.object({ uri: z.url(), section: z.string().trim().min(1).max(300) }).strict(),
      reason: reasonSchema,
      impactMonths: impactMonthsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('retire-rule'),
      ruleId: uuidSchema,
      reason: reasonSchema,
      impactMonths: impactMonthsSchema,
    })
    .strict(),
])

export type FiscalRuleChangeRequest = z.input<typeof fiscalRuleChangeRequestSchema>

export const FISCAL_RULE_CHANGE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const

/** `POST /fiscal/rule-changes/:id/approve|reject|cancel`. */
export const fiscalRuleChangeDecisionRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(1000).optional() })
  .strict()

/** A request, what it would change, and how it was decided. */
export const fiscalRuleChangeSchema = z.object({
  id: uuidSchema,
  kind: z.enum(['adopt-package', 'withdraw-package', 'add-rule', 'retire-rule']),
  status: z.enum(FISCAL_RULE_CHANGE_STATUSES),
  request: z.record(z.string(), z.unknown()),
  requestDigest: digestSchema,
  requestedBy: z.string().min(1).max(200),
  requestedAt: instantSchema,
  diff: fiscalRuleDiffSchema,
  impact: fiscalRuleImpactSchema,
  decision: z
    .object({
      outcome: z.enum(['approved', 'rejected', 'cancelled']),
      decidedBy: z.string().min(1).max(200),
      onBehalfOf: z.string().min(1).max(200).nullable(),
      delegationId: uuidSchema.nullable(),
      decidedAt: instantSchema,
      reason: z.string().nullable(),
      /** The adoption, withdrawal or rule the approval created. */
      resultId: uuidSchema.nullable(),
    })
    .nullable(),
})

export type FiscalRuleChange = z.infer<typeof fiscalRuleChangeSchema>

export const fiscalRuleChangeListSchema = z.object({
  data: z.array(
    fiscalRuleChangeSchema.omit({ diff: true, impact: true }).extend({
      counts: fiscalRuleDiffSchema.shape.counts,
      changedDocuments: z.int().nonnegative(),
      unsupportedDocuments: z.int().nonnegative(),
    }),
  ),
})
