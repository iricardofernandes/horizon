import { createHash, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from './audit'
import { canonicalDigest } from './canonical-json'
import {
  deterministicUuid,
  referenceEntrySchema,
  taxRuleImportSchema,
  toTaxRule,
} from './rule-rows'
import type { TaxRule } from './rules'

const date = z.iso.date()
const digest = z.string().regex(/^[0-9a-f]{64}$/)

/** Law is scoped by operation or by default, never by one workspace's own records. */
const catalogRuleSchema = taxRuleImportSchema.superRefine((rule, context) => {
  if (rule.precedence !== 'operation' && rule.precedence !== 'default')
    context.addIssue({
      code: 'custom',
      path: ['precedence'],
      message: 'a catalogue rule is law: its precedence is operation or default',
    })
  if (rule.issuerEstablishmentId || rule.recipientPartyId || rule.subject)
    context.addIssue({
      code: 'custom',
      path: ['precedence'],
      message: 'a catalogue rule is never scoped to an establishment, a party or an item',
    })
})

const publicationSchema = z.object({
  authority: z.string().min(1).max(200),
  sourceUri: z.url(),
  publishedAt: date,
  effectiveFrom: date,
  publisher: z.string().min(1).max(200),
  artifact: z.object({ digest, byteSize: z.int().positive() }).optional(),
  entries: z.array(referenceEntrySchema).max(100_000),
  rules: z.array(catalogRuleSchema).max(100_000),
})

export type CatalogPublication = z.input<typeof publicationSchema> & { bytes: Buffer }

/**
 * Identifiers a package keeps from before it was in the catalogue. Phase 41's package keeps
 * its own, so its approved result keeps its digests (ADR 0070).
 */
export type PreservedIdentity = {
  packageId: string
  ruleIds: Readonly<Record<string, string>>
}

const adoptionSchema = z.object({
  tenantId: z.uuid(),
  packageId: z.uuid(),
  effectiveFrom: date,
  reviewedBy: z.string().min(1).max(200),
  interpretation: z.string().min(1).max(4000),
  fixtureIds: z.array(z.string().min(1).max(200)).max(1000).default([]),
  actorId: z.string().min(1).max(200),
  reason: z.string().min(1).max(1000),
})

const withdrawalSchema = z.object({
  tenantId: z.uuid(),
  packageId: z.uuid(),
  actorId: z.string().min(1).max(200),
  reason: z.string().min(1).max(1000),
})

/** An adoption that would tie with one of the workspace's own active rules. */
export class CatalogAdoptionClash extends Error {
  constructor(readonly clashes: readonly { catalogRuleId: string; workspaceRuleId: string }[]) {
    super('adopting this package would tie with active workspace rules; retire them first')
  }
}

/** The scope columns two rules must share to tie; a window overlap is checked beside them. */
const TIE_COLUMNS = [
  'component_group',
  'component_code',
  'precedence',
  'priority',
  'model',
  'environment',
  'purpose',
  'operation',
  'issuer_establishment_id',
  'issuer_regime',
  'recipient_party_id',
  'recipient_regime',
  'origin_state',
  'destination_state',
  'subject_kind',
  'subject_id',
  'classification_kind',
  'classification_code',
] as const

/**
 * Tax law shared by every workspace (ADR 0070). Publishing needs the migration role, since the
 * application may only read the catalogue; adopting and withdrawing are a workspace's own
 * events, under its RLS.
 */
export class FiscalCatalog {
  readonly #db: ReturnType<typeof postgres>

  constructor(databaseUrl: string, statementTimeout = 10_000) {
    this.#db = postgres(databaseUrl, {
      max: 5,
      connection: { statement_timeout: statementTimeout },
    })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async publish(
    candidate: CatalogPublication,
    preserved?: PreservedIdentity,
  ): Promise<{ packageId: string; packageDigest: string; existing: boolean; ruleIds: string[] }> {
    if (!Buffer.isBuffer(candidate.bytes) || candidate.bytes.length === 0)
      throw new Error('Catalogue source bytes are required')
    const value = publicationSchema.parse(candidate)
    const packageDigest =
      value.artifact?.digest ?? createHash('sha256').update(candidate.bytes).digest('hex')
    return this.#db.begin(async (tx) => {
      const [prior] = await tx`select id, source_bytes from fiscal_catalog_packages
        where authority = ${value.authority} and package_digest = ${packageDigest}`
      const packageId = prior
        ? String(prior.id)
        : (preserved?.packageId ?? deterministicUuid('catalog', value.authority, packageDigest))
      if (prior) {
        if (!Buffer.from(prior.source_bytes).equals(candidate.bytes))
          throw new Error('Catalogue source package digest collision')
      } else
        await tx`insert into fiscal_catalog_packages (
          id, authority, source_uri, package_digest, published_at, effective_from, source_bytes,
          artifact_digest, artifact_byte_size, publisher
        ) values (
          ${packageId}, ${value.authority}, ${value.sourceUri}, ${packageDigest},
          ${value.publishedAt}, ${value.effectiveFrom}, ${candidate.bytes},
          ${value.artifact?.digest ?? null}, ${value.artifact?.byteSize ?? null}, ${value.publisher}
        )`
      for (const entry of value.entries) {
        const rowDigest = canonicalDigest(entry)
        await tx`insert into fiscal_catalog_references (
          id, package_id, family, code, description, model, jurisdiction, effective_from,
          effective_to, source_locator, row_digest
        ) values (
          ${deterministicUuid('catalog', packageId, entry.family, entry.code, entry.model, entry.jurisdiction, entry.effectiveFrom)},
          ${packageId}, ${entry.family}, ${entry.code}, ${entry.description}, ${entry.model},
          ${entry.jurisdiction}, ${entry.effectiveFrom}, ${entry.effectiveTo ?? null},
          ${entry.sourceLocator}, ${rowDigest}
        ) on conflict (package_id, family, code, model, jurisdiction, effective_from) do nothing`
      }
      const ruleIds: string[] = []
      for (const rule of value.rules) {
        const definitionDigest = canonicalDigest(rule)
        const [existing] = await tx`select id, package_id, definition_digest
          from fiscal_catalog_rules where rule_key = ${rule.ruleKey} and version = ${rule.version}`
        if (existing) {
          if (existing.package_id !== packageId || existing.definition_digest !== definitionDigest)
            throw new Error('Conflicting catalogue rule version')
          ruleIds.push(String(existing.id))
          continue
        }
        const id =
          preserved?.ruleIds[rule.ruleKey] ??
          deterministicUuid('catalog', packageId, rule.ruleKey, String(rule.version))
        await tx`insert into fiscal_catalog_rules (
          id, package_id, rule_key, version, component_group, component_code, precedence,
          priority, date_basis, purpose, model, environment, operation, issuer_regime,
          recipient_regime, origin_state, destination_state, classification_kind,
          classification_code, effective_from, effective_to, rate_numerator, rate_denominator,
          formula, source_locator, definition_digest
        ) values (
          ${id}, ${packageId}, ${rule.ruleKey}, ${rule.version},
          ${rule.group === 'ibsCbs' ? 'ibs_cbs' : 'legacy'}, ${rule.code}, ${rule.precedence},
          ${rule.priority}, ${rule.dateBasis}, ${rule.purpose}, ${rule.model}, ${rule.environment},
          ${rule.operation ?? '*'}, ${rule.issuerRegime ?? '*'}, ${rule.recipientRegime ?? '*'},
          ${rule.originState ?? '*'}, ${rule.destinationState ?? '*'},
          ${rule.classification?.kind ?? '*'}, ${rule.classification?.code ?? '*'},
          ${rule.effectiveFrom}, ${rule.effectiveTo ?? null}, ${rule.rate.numerator},
          ${rule.rate.denominator}, ${rule.formula}, ${rule.sourceLocator}, ${definitionDigest}
        )`
        ruleIds.push(id)
      }
      return { packageId, packageDigest, existing: Boolean(prior), ruleIds }
    })
  }

  async adopt(input: z.input<typeof adoptionSchema>): Promise<string> {
    const value = adoptionSchema.parse(input)
    const id = randomUUID()
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const clashes = await clashesWithWorkspace(tx, value.tenantId, value.packageId)
      if (clashes.length) throw new CatalogAdoptionClash(clashes)
      await tx`insert into fiscal_package_adoptions (
        id, tenant_id, package_id, action, effective_from, reviewed_by, interpretation,
        fixture_ids, actor_id, reason
      ) values (
        ${id}, ${value.tenantId}, ${value.packageId}, 'adopt', ${value.effectiveFrom},
        ${value.reviewedBy}, ${value.interpretation}, ${value.fixtureIds}, ${value.actorId},
        ${value.reason}
      )`
      await appendAudit(tx, {
        tenantId: value.tenantId,
        actorId: value.actorId,
        action: 'catalog.package-adopted',
        resourceId: value.packageId,
        detail: {
          effectiveFrom: value.effectiveFrom,
          reviewedBy: value.reviewedBy,
          fixtureIds: value.fixtureIds,
          reason: value.reason,
        },
      })
    })
    return id
  }

  async withdraw(input: z.input<typeof withdrawalSchema>): Promise<string> {
    const value = withdrawalSchema.parse(input)
    const id = randomUUID()
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      await tx`insert into fiscal_package_adoptions (
        id, tenant_id, package_id, action, actor_id, reason
      ) values (
        ${id}, ${value.tenantId}, ${value.packageId}, 'withdraw', ${value.actorId}, ${value.reason}
      )`
      await appendAudit(tx, {
        tenantId: value.tenantId,
        actorId: value.actorId,
        action: 'catalog.package-withdrawn',
        resourceId: value.packageId,
        detail: { reason: value.reason },
      })
    })
    return id
  }
}

/** The catalogue rules a workspace has adopted, as rules of that workspace, approved and active. */
export async function adoptedCatalogRules(
  tx: postgres.TransactionSql,
  tenantId: string,
  model: string,
  environment: string,
): Promise<TaxRule[]> {
  const rows = await tx`select rule.*, ${tenantId}::uuid as tenant_id,
    greatest(rule.effective_from, adoption.effective_from)::text as effective_from,
    rule.effective_to::text as effective_to, package.source_uri, package.package_digest,
    true as approved, 'activate' as action
    from fiscal_catalog_rules rule
    join fiscal_catalog_packages package on package.id = rule.package_id
    join lateral (
      select event.action, event.effective_from from fiscal_package_adoptions event
      where event.tenant_id = ${tenantId} and event.package_id = rule.package_id
      order by event.sequence desc limit 1
    ) adoption on adoption.action = 'adopt'
    where rule.model = ${model} and rule.environment = ${environment}
      and (rule.effective_to is null or rule.effective_to > adoption.effective_from)`
  return rows.map(toTaxRule)
}

/** The reference entries of adopted packages, which count as approved. */
export async function adoptedCatalogReferences(
  tx: postgres.TransactionSql,
  tenantId: string,
): Promise<postgres.Row[]> {
  return tx`select entry.family, entry.code, entry.model, entry.jurisdiction,
    entry.effective_from::text, entry.effective_to::text
    from fiscal_catalog_references entry
    join lateral (
      select event.action from fiscal_package_adoptions event
      where event.tenant_id = ${tenantId} and event.package_id = entry.package_id
      order by event.sequence desc limit 1
    ) adoption on adoption.action = 'adopt'`
}

/** Package rules that an active workspace rule would tie with, over an overlapping window. */
async function clashesWithWorkspace(
  tx: postgres.TransactionSql,
  tenantId: string,
  packageId: string,
): Promise<{ catalogRuleId: string; workspaceRuleId: string }[]> {
  const same = TIE_COLUMNS.map((column) => `catalog.${column} = own.${column}`).join(' and ')
  const rows = await tx.unsafe(
    `select catalog.id as catalog_rule_id, own.id as workspace_rule_id
     from fiscal_catalog_rules catalog
     join fiscal_tax_rules own on own.tenant_id = $1 and ${same}
       and daterange(catalog.effective_from, catalog.effective_to, '[)') &&
           daterange(own.effective_from, own.effective_to, '[)')
     join lateral (
       select event.action from fiscal_rule_activation_events event
       where event.tenant_id = own.tenant_id and event.rule_id = own.id
       order by event.sequence desc limit 1
     ) latest on latest.action = 'activate'
     where catalog.package_id = $2`,
    [tenantId, packageId],
  )
  return rows.map((row) => ({
    catalogRuleId: String(row.catalog_rule_id),
    workspaceRuleId: String(row.workspace_rule_id),
  }))
}
