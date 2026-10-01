import type {
  FiscalCatalogPackage,
  FiscalRuleSummary,
  fiscalWorkspaceRuleListSchema,
} from '@horizon/contracts'
import type postgres from 'postgres'
import type { z } from 'zod'
import { ruleSummaryOf, toTaxRule } from './rule-rows'
import type { TaxRule } from './rules'

/**
 * What the governance screens read (Phase 88): the catalogue with this workspace's adoption
 * state, the workspace's own rows, and the rules it calculates with today. Every query runs
 * in a transaction already scoped to the tenant.
 */

const PENDING = `not exists (select 1 from fiscal_rule_change_decisions decision
  where decision.tenant_id = change.tenant_id and decision.change_id = change.id)`

export async function catalogPackages(
  tx: postgres.TransactionSql,
  tenantId: string,
): Promise<FiscalCatalogPackage[]> {
  const rows = await tx.unsafe(
    `select package.id, package.authority, package.source_uri, package.package_digest,
       package.published_at::text, package.effective_from::text, package.publisher,
       (select count(*)::int from fiscal_catalog_rules rule where rule.package_id = package.id)
         as rule_count,
       (select count(*)::int from fiscal_catalog_references entry
         where entry.package_id = package.id) as reference_count,
       (select coalesce(array_agg(distinct rule.component_code order by rule.component_code), '{}')
         from fiscal_catalog_rules rule where rule.package_id = package.id) as components,
       adoption.action, adoption.effective_from::text as adopted_from, adoption.created_at,
       (select change.id from fiscal_rule_changes change
         where change.tenant_id = $1 and change.subject_key = 'package:' || package.id::text
           and ${PENDING} limit 1) as pending_change_id
     from fiscal_catalog_packages package
     left join lateral (
       select event.action, event.effective_from, event.created_at
       from fiscal_package_adoptions event
       where event.tenant_id = $1 and event.package_id = package.id
       order by event.sequence desc limit 1
     ) adoption on true
     order by package.published_at desc, package.authority, package.id`,
    [tenantId],
  )
  return rows.map((row) => ({
    id: String(row.id),
    authority: String(row.authority),
    sourceUri: String(row.source_uri),
    packageDigest: String(row.package_digest),
    publishedAt: String(row.published_at),
    effectiveFrom: String(row.effective_from),
    publisher: String(row.publisher),
    ruleCount: Number(row.rule_count),
    referenceCount: Number(row.reference_count),
    components: (row.components as string[]).slice(0, 64),
    adoption: {
      state: row.action === 'adopt' ? 'adopted' : row.action === 'withdraw' ? 'withdrawn' : 'never',
      effectiveFrom: row.action === 'adopt' ? String(row.adopted_from) : null,
      decidedAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    },
    pendingChangeId: row.pending_change_id ? String(row.pending_change_id) : null,
  }))
}

/** The latest adoption event of a package for this workspace, if any. */
export async function adoptionOf(
  tx: postgres.TransactionSql,
  tenantId: string,
  packageId: string,
): Promise<'adopt' | 'withdraw' | null> {
  const [row] = await tx`select action from fiscal_package_adoptions
    where tenant_id = ${tenantId} and package_id = ${packageId}
    order by sequence desc limit 1`
  return row ? (row.action as 'adopt' | 'withdraw') : null
}

const OWN_RULES = `select rule.*, rule.effective_from::text as effective_from,
    rule.effective_to::text as effective_to, package.source_uri, package.package_digest,
    coalesce(review.approved, false) as approved, latest.action
  from fiscal_tax_rules rule
  join fiscal_source_packages package
    on package.tenant_id = rule.tenant_id and package.id = rule.package_id
  left join fiscal_package_reviews review
    on review.tenant_id = rule.tenant_id and review.package_id = rule.package_id
  left join lateral (
    select event.action from fiscal_rule_activation_events event
    where event.tenant_id = rule.tenant_id and event.rule_id = rule.id
    order by event.sequence desc limit 1
  ) latest on true
  where rule.tenant_id = $1`

/** Every own row of the workspace, approved and active or not. */
export async function workspaceRules(
  tx: postgres.TransactionSql,
  tenantId: string,
): Promise<z.infer<typeof fiscalWorkspaceRuleListSchema>['data']> {
  const rows = await tx.unsafe(`${OWN_RULES} order by rule.rule_key, rule.version`, [tenantId])
  return rows.map((row) => ({
    ...ruleSummaryOf(row),
    packageId: String(row.package_id),
    approved: row.approved === true,
    active: row.action === 'activate',
  }))
}

/** One own row, with its state, or null. */
export async function workspaceRule(
  tx: postgres.TransactionSql,
  tenantId: string,
  ruleId: string,
): Promise<postgres.Row | null> {
  const [row] = await tx.unsafe(`${OWN_RULES} and rule.id = $2`, [tenantId, ruleId])
  return row ?? null
}

/** The rules the workspace calculates with today: adopted catalogue rules and active own rows. */
export async function rulesInForce(
  tx: postgres.TransactionSql,
  tenantId: string,
): Promise<FiscalRuleSummary[]> {
  const own = await tx.unsafe(`${OWN_RULES} order by rule.rule_key`, [tenantId])
  const adopted = await tx`select rule.*, rule.effective_from::text as effective_from,
      rule.effective_to::text as effective_to
    from fiscal_catalog_rules rule
    join lateral (
      select event.action from fiscal_package_adoptions event
      where event.tenant_id = ${tenantId} and event.package_id = rule.package_id
      order by event.sequence desc limit 1
    ) adoption on adoption.action = 'adopt'`
  return [
    ...own.filter((row) => row.action === 'activate').map(ruleSummaryOf),
    ...adopted.map(ruleSummaryOf),
  ]
}

/** A catalogue package's rules, as summaries and as rules of this workspace, and its references. */
export async function packageRules(
  tx: postgres.TransactionSql,
  tenantId: string,
  packageId: string,
): Promise<{
  summaries: FiscalRuleSummary[]
  rules: TaxRule[]
  references: postgres.Row[]
}> {
  const rows = await tx`select rule.*, ${tenantId}::uuid as tenant_id,
      rule.effective_from::text as effective_from, rule.effective_to::text as effective_to,
      package.source_uri, package.package_digest, true as approved, 'activate' as action
    from fiscal_catalog_rules rule
    join fiscal_catalog_packages package on package.id = rule.package_id
    where rule.package_id = ${packageId}
    order by rule.rule_key, rule.version`
  const references = await tx`select family, code, model, jurisdiction,
      effective_from::text, effective_to::text, package_id
    from fiscal_catalog_references where package_id = ${packageId}`
  return { summaries: rows.map(ruleSummaryOf), rules: rows.map(toTaxRule), references }
}

/** Whether the package exists in the catalogue. */
export async function packageExists(
  tx: postgres.TransactionSql,
  packageId: string,
): Promise<boolean> {
  const [row] = await tx`select 1 from fiscal_catalog_packages where id = ${packageId}`
  return Boolean(row)
}
