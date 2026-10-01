import { createHash } from 'node:crypto'
import type { FiscalRuleDiff, fiscalRuleChangeRequestSchema } from '@horizon/contracts'
import type postgres from 'postgres'
import type { z } from 'zod'
import { appendAudit } from './audit'
import { canonicalJson } from './canonical-json'
import {
  CatalogAdoptionClash,
  clashesWithWorkspace,
  recordAdoption,
  recordWithdrawal,
  TIE_COLUMNS,
} from './catalog'
import {
  adoptionOf,
  packageExists,
  packageRules,
  rulesInForce,
  workspaceRule,
} from './catalog-reads'
import { packageProblem, ruleReferences } from './formula'
import { diffRules } from './rule-diff'
import {
  deterministicUuid,
  ruleRowOf,
  ruleSummaryOf,
  type TaxRuleImport,
  taxRuleImportSchema,
  toTaxRule,
} from './rule-rows'
import { insertTaxRule, type RuleOverlay } from './rule-store'

export type ParsedChangeRequest = z.output<typeof fiscalRuleChangeRequestSchema>

export class RuleChangeRefused extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

/** What a request is about, what it does to the rules, and how to recalculate with it. */
export type ChangePlan = {
  subjectKey: string
  diff: FiscalRuleDiff
  overlay: RuleOverlay
}

const NO_OVERLAY: RuleOverlay = {
  addRules: [],
  addReferences: [],
  withoutRuleIds: new Set(),
  withoutPackageIds: new Set(),
}
const WORKSPACE = { kind: 'workspace' } as const

/** Checks that a request can be made now, and plans it. Nothing is written. */
export async function planChange(
  tx: postgres.TransactionSql,
  tenantId: string,
  request: ParsedChangeRequest,
): Promise<ChangePlan> {
  switch (request.kind) {
    case 'adopt-package': {
      await requirePackage(tx, request.packageId)
      if ((await adoptionOf(tx, tenantId, request.packageId)) === 'adopt')
        throw new RuleChangeRefused(409, 'The workspace already adopted this package')
      const clashes = await clashesWithWorkspace(tx, tenantId, request.packageId)
      if (clashes.length)
        throw new RuleChangeRefused(
          409,
          'Adopting this package would tie with active workspace rules; retire them first',
          { clashes },
        )
      const incoming = await packageRules(tx, tenantId, request.packageId)
      const keys = new Set(incoming.summaries.map((rule) => rule.ruleKey))
      const current = (await rulesInForce(tx, tenantId)).filter((rule) => keys.has(rule.ruleKey))
      return {
        subjectKey: `package:${request.packageId}`,
        diff: diffRules(current, incoming.summaries, WORKSPACE),
        overlay: { ...NO_OVERLAY, addRules: incoming.rules, addReferences: incoming.references },
      }
    }
    case 'withdraw-package': {
      await requirePackage(tx, request.packageId)
      if ((await adoptionOf(tx, tenantId, request.packageId)) !== 'adopt')
        throw new RuleChangeRefused(409, 'The workspace has not adopted this package')
      const outgoing = await packageRules(tx, tenantId, request.packageId)
      return {
        subjectKey: `package:${request.packageId}`,
        diff: diffRules(outgoing.summaries, [], WORKSPACE),
        overlay: { ...NO_OVERLAY, withoutPackageIds: new Set([request.packageId]) },
      }
    }
    case 'add-rule': {
      const planned = workspaceRuleOf(tenantId, request)
      const [existing] = await tx`select 1 from fiscal_tax_rules where tenant_id = ${tenantId}
        and rule_key = ${planned.rule.ruleKey} and version = ${planned.rule.version}`
      if (existing)
        throw new RuleChangeRefused(409, 'The workspace already has this rule key and version')
      await refuseTies(tx, tenantId, planned.row)
      const current = (await rulesInForce(tx, tenantId)).filter(
        (rule) => rule.ruleKey === planned.rule.ruleKey,
      )
      return {
        subjectKey: `rule-key:${planned.rule.ruleKey}`,
        diff: diffRules(current, [ruleSummaryOf(planned.row)], WORKSPACE),
        overlay: {
          ...NO_OVERLAY,
          addRules: [
            toTaxRule({
              ...planned.row,
              source_uri: request.sourceBasis.uri,
              package_digest: planned.packageDigest,
              approved: true,
              action: 'activate',
            }),
          ],
        },
      }
    }
    case 'retire-rule': {
      const row = await workspaceRule(tx, tenantId, request.ruleId)
      if (!row) throw new RuleChangeRefused(404, 'Workspace rule not found')
      if (row.action !== 'activate')
        throw new RuleChangeRefused(409, 'The workspace rule is not active')
      return {
        subjectKey: `rule:${request.ruleId}`,
        diff: diffRules([ruleSummaryOf(row)], [], WORKSPACE),
        overlay: { ...NO_OVERLAY, withoutRuleIds: new Set([request.ruleId]) },
      }
    }
  }
}

/**
 * Applies an approved request inside the approving transaction, after checking it still
 * applies, and returns what it created: the adoption, the withdrawal, the rule or the
 * deactivation.
 */
export async function applyChange(
  tx: postgres.TransactionSql,
  input: {
    tenantId: string
    changeId: string
    request: ParsedChangeRequest
    requestedBy: string
    approvedBy: string
    now: Date
  },
): Promise<string> {
  const { tenantId, request } = input
  switch (request.kind) {
    case 'adopt-package': {
      if ((await adoptionOf(tx, tenantId, request.packageId)) === 'adopt')
        throw new RuleChangeRefused(409, 'The workspace already adopted this package')
      try {
        return await recordAdoption(tx, {
          tenantId,
          packageId: request.packageId,
          effectiveFrom: request.effectiveFrom,
          reviewedBy: input.approvedBy,
          interpretation: request.interpretation,
          fixtureIds: request.fixtureIds,
          actorId: input.approvedBy,
          reason: request.reason,
        })
      } catch (error) {
        if (error instanceof CatalogAdoptionClash)
          throw new RuleChangeRefused(409, error.message, { clashes: error.clashes })
        throw error
      }
    }
    case 'withdraw-package': {
      if ((await adoptionOf(tx, tenantId, request.packageId)) !== 'adopt')
        throw new RuleChangeRefused(409, 'The workspace has not adopted this package')
      return recordWithdrawal(tx, {
        tenantId,
        packageId: request.packageId,
        actorId: input.approvedBy,
        reason: request.reason,
      })
    }
    case 'add-rule':
      return addWorkspaceRule(tx, input, request)
    case 'retire-rule': {
      const row = await workspaceRule(tx, tenantId, request.ruleId)
      if (row?.action !== 'activate')
        throw new RuleChangeRefused(409, 'The workspace rule is no longer active')
      const id = deterministicUuid(tenantId, 'rule-change', input.changeId)
      await tx`insert into fiscal_rule_activation_events (
        id, tenant_id, rule_id, action, actor_id, reason
      ) values (
        ${id}, ${tenantId}, ${request.ruleId}, 'deactivate', ${input.approvedBy},
        ${`rule change ${input.changeId}: ${request.reason}`.slice(0, 1000)}
      )`
      await appendAudit(tx, {
        tenantId,
        actorId: input.approvedBy,
        action: 'rule.retired',
        resourceId: request.ruleId,
        detail: { changeId: input.changeId, requestedBy: input.requestedBy },
      })
      return id
    }
  }
}

async function requirePackage(tx: postgres.TransactionSql, packageId: string): Promise<void> {
  if (!(await packageExists(tx, packageId)))
    throw new RuleChangeRefused(404, 'Catalogue package not found')
}

type PlannedRule = {
  rule: TaxRuleImport
  bytes: Buffer
  packageDigest: string
  packageId: string
  ruleId: string
  row: Record<string, unknown>
}

/**
 * A workspace rule as its own source package: the definition and its legal basis are the
 * package's bytes, so the rule cites exactly what was approved.
 */
function workspaceRuleOf(
  tenantId: string,
  request: Extract<ParsedChangeRequest, { kind: 'add-rule' }>,
): PlannedRule {
  const parsed = taxRuleImportSchema.safeParse(request.definition)
  if (!parsed.success)
    throw new RuleChangeRefused(
      400,
      `Invalid rule definition: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${
        parsed.error.issues[0]?.message ?? ''
      }`.trim(),
    )
  const rule = parsed.data
  if (rule.precedence === 'default')
    throw new RuleChangeRefused(400, 'A default rule is law, which only the catalogue publishes')
  const reads = rule.expression
    ? ruleReferences(rule.expression).filter((code) => code !== rule.code)
    : []
  const problem = packageProblem([rule], reads)
  if (problem) throw new RuleChangeRefused(400, `Invalid rule formula: ${problem}`)
  const bytes = Buffer.from(canonicalJson({ definition: rule, sourceBasis: request.sourceBasis }))
  const packageDigest = createHash('sha256').update(bytes).digest('hex')
  const packageId = deterministicUuid(tenantId, 'workspace', packageDigest)
  const ruleId = deterministicUuid(tenantId, packageId, rule.ruleKey, String(rule.version))
  return {
    rule,
    bytes,
    packageDigest,
    packageId,
    ruleId,
    row: ruleRowOf(tenantId, packageId, ruleId, rule),
  }
}

/**
 * A new rule may not tie with any own row (the store refuses an equal scope over an
 * overlapping window, whatever its state) nor with an adopted catalogue rule, since a tie
 * makes resolution ambiguous (ADR 0070).
 */
async function refuseTies(
  tx: postgres.TransactionSql,
  tenantId: string,
  row: Record<string, unknown>,
): Promise<void> {
  const values = TIE_COLUMNS.map((column) => String(row[column]))
  const same = (alias: string) =>
    TIE_COLUMNS.map((column, index) => `${alias}.${column} = $${index + 4}`).join(' and ')
  const window = (alias: string) =>
    `daterange(${alias}.effective_from, ${alias}.effective_to, '[)') && daterange($2::date, $3::date, '[)')`
  const parameters = [tenantId, row.effective_from, row.effective_to, ...values] as never[]
  const own = await tx.unsafe(
    `select id from fiscal_tax_rules own where own.tenant_id = $1 and ${same('own')}
       and ${window('own')} limit 1`,
    parameters,
  )
  const adopted = await tx.unsafe(
    `select catalog.id from fiscal_catalog_rules catalog
     join lateral (
       select event.action from fiscal_package_adoptions event
       where event.tenant_id = $1 and event.package_id = catalog.package_id
       order by event.sequence desc limit 1
     ) adoption on adoption.action = 'adopt'
     where ${same('catalog')} and ${window('catalog')} limit 1`,
    parameters,
  )
  const tie = own[0] ?? adopted[0]
  if (tie)
    throw new RuleChangeRefused(
      409,
      'The rule ties with an existing rule of the same scope and priority over an overlapping window',
      { tiesWith: String(tie.id) },
    )
}

async function addWorkspaceRule(
  tx: postgres.TransactionSql,
  input: { tenantId: string; changeId: string; requestedBy: string; approvedBy: string; now: Date },
  request: Extract<ParsedChangeRequest, { kind: 'add-rule' }>,
): Promise<string> {
  const { tenantId } = input
  const planned = workspaceRuleOf(tenantId, request)
  await refuseTies(tx, tenantId, planned.row)
  const today = input.now.toISOString().slice(0, 10)
  await tx`insert into fiscal_source_packages (
    id, tenant_id, authority, source_uri, package_digest, published_at, effective_from
  ) values (
    ${planned.packageId}, ${tenantId}, 'workspace', ${request.sourceBasis.uri},
    ${planned.packageDigest}, ${today}, ${planned.rule.effectiveFrom}
  )`
  // The requester retains the bytes and the approver reviews them: the store's own guard
  // refuses one person doing both (Phase 41).
  await tx`insert into fiscal_source_payloads (
    tenant_id, package_id, source_bytes, byte_size, imported_by
  ) values (
    ${tenantId}, ${planned.packageId}, ${planned.bytes}, ${planned.bytes.length},
    ${input.requestedBy}
  )`
  const ruleId = await insertTaxRule(tx, tenantId, planned.packageId, planned.rule)
  await tx`insert into fiscal_package_reviews (
    id, tenant_id, package_id, approved, reviewed_by, reviewed_at, interpretation, fixture_ids
  ) values (
    ${deterministicUuid(tenantId, 'rule-change-review', input.changeId)}, ${tenantId},
    ${planned.packageId}, true, ${input.approvedBy}, ${input.now},
    ${`${request.sourceBasis.section}: ${request.reason}`.slice(0, 4000)}, ${[]}
  )`
  await tx`insert into fiscal_rule_activation_events (
    id, tenant_id, rule_id, action, actor_id, reason
  ) values (
    ${deterministicUuid(tenantId, 'rule-change', input.changeId)}, ${tenantId}, ${ruleId},
    'activate', ${input.approvedBy}, ${`rule change ${input.changeId}`}
  )`
  await appendAudit(tx, {
    tenantId,
    actorId: input.approvedBy,
    action: 'rule.added',
    resourceId: ruleId,
    detail: {
      changeId: input.changeId,
      requestedBy: input.requestedBy,
      ruleKey: planned.rule.ruleKey,
      version: planned.rule.version,
      packageDigest: planned.packageDigest,
      sourceBasis: request.sourceBasis,
    },
  })
  return ruleId
}
