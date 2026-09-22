import { createHash, randomUUID } from 'node:crypto'
import { type FiscalCalculationInput, fiscalCalculationInputSchema } from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { canonicalDigest } from './canonical-json'
import { type RuleResolution, resolveTaxRules, type TaxRule } from './rules'

const date = z.iso.date()
const digest = z.string().regex(/^[0-9a-f]{64}$/)

const referenceEntrySchema = z.object({
  family: z.enum(['cfop', 'ncm', 'cest', 'cst', 'csosn', 'ibs_cbs', 'service']),
  code: z.string().min(1).max(40),
  description: z.string().min(1).max(1000),
  model: z.enum(['*', '55', '65', 'nfse']).default('*'),
  jurisdiction: z.string().min(1).max(20).default('*'),
  effectiveFrom: date,
  effectiveTo: date.optional(),
  sourceLocator: z.string().min(1).max(300),
})

const taxRuleImportSchema = z.object({
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
  recipientRegime: z.string().min(1).max(80).optional(),
  originState: z
    .string()
    .regex(/^\d{2}$/)
    .optional(),
  destinationState: z
    .string()
    .regex(/^\d{2}$/)
    .optional(),
  subject: z.object({ kind: z.enum(['item', 'service']), id: z.uuid() }).optional(),
  classification: z
    .object({
      kind: z.enum(['ncm', 'cest', 'service', 'origin']),
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
  formula: z.enum(['LINE_NET_TIMES_RATE', 'DOCUMENT_NET_TIMES_RATE', 'RETURN_LINE_NET_TIMES_RATE']),
  sourceLocator: z.string().min(1).max(300),
})

const sourceImportSchema = z.object({
  tenantId: z.uuid(),
  authority: z.string().min(1).max(200),
  sourceUri: z.url(),
  publishedAt: date,
  effectiveFrom: date,
  importedBy: z.string().min(1).max(200),
  entries: z.array(referenceEntrySchema).max(100_000),
  rules: z.array(taxRuleImportSchema).max(100_000),
})

export type SourceImport = z.input<typeof sourceImportSchema> & { bytes: Buffer }
export type SourceImportResult = {
  packageId: string
  packageDigest: string
  existing: boolean
  ruleIds: string[]
}

export class FiscalRuleStore {
  readonly #db: ReturnType<typeof postgres>

  constructor(databaseUrl: string) {
    this.#db = postgres(databaseUrl, { max: 10, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async importSource(candidate: SourceImport): Promise<SourceImportResult> {
    if (!Buffer.isBuffer(candidate.bytes) || candidate.bytes.length === 0)
      throw new Error('Fiscal source bytes are required')
    const value = sourceImportSchema.parse(candidate)
    const packageDigest = createHash('sha256').update(candidate.bytes).digest('hex')
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const [prior] = await tx`select id, source_uri, published_at::text, effective_from::text
        from fiscal_source_packages where tenant_id = ${value.tenantId}
          and authority = ${value.authority} and package_digest = ${packageDigest}`
      const packageId = prior ? String(prior.id) : randomUUID()
      if (prior) {
        if (
          prior.source_uri !== value.sourceUri ||
          prior.published_at !== value.publishedAt ||
          prior.effective_from !== value.effectiveFrom
        )
          throw new Error('Conflicting metadata for existing Fiscal source package')
        const [payload] = await tx`select source_bytes from fiscal_source_payloads
          where tenant_id = ${value.tenantId} and package_id = ${packageId}`
        if (payload && !Buffer.from(payload.source_bytes).equals(candidate.bytes))
          throw new Error('Fiscal source package digest collision')
      } else {
        await tx`insert into fiscal_source_packages (
          id, tenant_id, authority, source_uri, package_digest, published_at, effective_from
        ) values (
          ${packageId}, ${value.tenantId}, ${value.authority}, ${value.sourceUri},
          ${packageDigest}, ${value.publishedAt}, ${value.effectiveFrom}
        )`
      }
      await tx`insert into fiscal_source_payloads (
        tenant_id, package_id, source_bytes, byte_size, imported_by
      ) values (
        ${value.tenantId}, ${packageId}, ${candidate.bytes}, ${candidate.bytes.length},
        ${value.importedBy}
      ) on conflict (tenant_id, package_id) do nothing`
      for (const entry of value.entries)
        await this.#insertReference(tx, value.tenantId, packageId, entry)
      const ruleIds: string[] = []
      for (const rule of value.rules)
        ruleIds.push(await this.#insertRule(tx, value.tenantId, packageId, rule))
      return { packageId, packageDigest, existing: Boolean(prior), ruleIds }
    })
  }

  async reviewPackage(input: {
    tenantId: string
    packageId: string
    approved: boolean
    reviewedBy: string
    reviewedAt: string
    interpretation: string
    fixtureIds: string[]
  }): Promise<string> {
    const value = z
      .object({
        tenantId: z.uuid(),
        packageId: z.uuid(),
        approved: z.boolean(),
        reviewedBy: z.string().min(1).max(200),
        reviewedAt: z.iso.datetime({ offset: true }),
        interpretation: z.string().min(1).max(4000),
        fixtureIds: z.array(z.string().min(1).max(200)).max(1000),
      })
      .parse(input)
    const id = randomUUID()
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      await tx`insert into fiscal_package_reviews (
        id, tenant_id, package_id, approved, reviewed_by, reviewed_at, interpretation, fixture_ids
      ) values (
        ${id}, ${value.tenantId}, ${value.packageId}, ${value.approved}, ${value.reviewedBy},
        ${value.reviewedAt}, ${value.interpretation}, ${value.fixtureIds}
      )`
    })
    return id
  }

  async activateRule(input: {
    tenantId: string
    ruleId: string
    action: 'activate' | 'deactivate'
    actorId: string
    reason: string
  }): Promise<string> {
    const value = z
      .object({
        tenantId: z.uuid(),
        ruleId: z.uuid(),
        action: z.enum(['activate', 'deactivate']),
        actorId: z.string().min(1).max(200),
        reason: z.string().min(1).max(1000),
      })
      .parse(input)
    const id = randomUUID()
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      await tx`insert into fiscal_rule_activation_events (
        id, tenant_id, rule_id, action, actor_id, reason
      ) values (
        ${id}, ${value.tenantId}, ${value.ruleId}, ${value.action}, ${value.actorId}, ${value.reason}
      )`
    })
    return id
  }

  async resolve(
    input: FiscalCalculationInput,
    currencyMinorUnitScale: number,
  ): Promise<RuleResolution> {
    const value = fiscalCalculationInputSchema.parse(input)
    const { rows, references } = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const rows = await tx`select rule.*, rule.effective_from::text as effective_from,
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
        where rule.tenant_id = ${value.tenantId} and rule.model = ${value.model}
          and rule.environment = ${value.environment}`
      const references = await tx`select entry.family, entry.code, entry.model,
        entry.jurisdiction, entry.effective_from::text, entry.effective_to::text
        from fiscal_reference_entries entry
        join fiscal_package_reviews review on review.tenant_id = entry.tenant_id
          and review.package_id = entry.package_id and review.approved
        where entry.tenant_id = ${value.tenantId}`
      return { rows, references }
    })
    const missing = missingApprovedReference(value, references)
    if (missing)
      return {
        supported: false,
        code: 'MISSING_CLASSIFICATION',
        detail: 'Classification is absent, expired or has no approved source',
        missingDimension: missing,
      }
    return resolveTaxRules(value, rows.map(toTaxRule), currencyMinorUnitScale)
  }

  async #insertReference(
    sql: postgres.TransactionSql,
    tenantId: string,
    packageId: string,
    entry: z.infer<typeof referenceEntrySchema>,
  ): Promise<void> {
    const rowDigest = canonicalDigest(entry)
    const inserted = await sql`insert into fiscal_reference_entries (
      id, tenant_id, package_id, family, code, description, model, jurisdiction,
      effective_from, effective_to, source_locator, row_digest
    ) values (
      ${randomUUID()}, ${tenantId}, ${packageId}, ${entry.family}, ${entry.code},
      ${entry.description}, ${entry.model}, ${entry.jurisdiction}, ${entry.effectiveFrom},
      ${entry.effectiveTo ?? null}, ${entry.sourceLocator}, ${rowDigest}
    ) on conflict (tenant_id, package_id, family, code, model, jurisdiction, effective_from)
      do nothing returning id`
    if (inserted.length === 0) {
      const [prior] = await sql`select row_digest from fiscal_reference_entries
        where tenant_id = ${tenantId} and package_id = ${packageId} and family = ${entry.family}
          and code = ${entry.code} and model = ${entry.model}
          and jurisdiction = ${entry.jurisdiction} and effective_from = ${entry.effectiveFrom}`
      if (prior?.row_digest !== rowDigest) throw new Error('Conflicting Fiscal reference entry')
    }
  }

  async #insertRule(
    sql: postgres.TransactionSql,
    tenantId: string,
    packageId: string,
    rule: z.infer<typeof taxRuleImportSchema>,
  ): Promise<string> {
    const definitionDigest = canonicalDigest(rule)
    await sql`select pg_advisory_xact_lock(hashtextextended(
      ${tenantId} || ':' || ${rule.ruleKey} || ':' || ${rule.version}::text, 0
    ))`
    const [prior] = await sql`select id, package_id, definition_digest from fiscal_tax_rules
      where tenant_id = ${tenantId} and rule_key = ${rule.ruleKey} and version = ${rule.version}`
    if (prior) {
      if (prior.package_id !== packageId || prior.definition_digest !== definitionDigest)
        throw new Error('Conflicting Fiscal tax rule version')
      return String(prior.id)
    }
    const id = randomUUID()
    await sql`insert into fiscal_tax_rules (
      id, tenant_id, package_id, rule_key, version, component_group, component_code,
      precedence, priority, date_basis, purpose, model, environment, operation, issuer_establishment_id,
      issuer_regime, recipient_regime, origin_state, destination_state, subject_kind,
      subject_id, classification_kind, classification_code, effective_from, effective_to,
      rate_numerator, rate_denominator, formula, source_locator, definition_digest
    ) values (
      ${id}, ${tenantId}, ${packageId}, ${rule.ruleKey}, ${rule.version},
      ${rule.group === 'ibsCbs' ? 'ibs_cbs' : 'legacy'}, ${rule.code}, ${rule.precedence},
      ${rule.priority}, ${rule.dateBasis}, ${rule.purpose}, ${rule.model}, ${rule.environment},
      ${rule.operation ?? '*'},
      ${rule.issuerEstablishmentId ?? '*'}, ${rule.issuerRegime ?? '*'},
      ${rule.recipientRegime ?? '*'}, ${rule.originState ?? '*'},
      ${rule.destinationState ?? '*'}, ${rule.subject?.kind ?? '*'},
      ${rule.subject?.id ?? '*'}, ${rule.classification?.kind ?? '*'},
      ${rule.classification?.code ?? '*'}, ${rule.effectiveFrom}, ${rule.effectiveTo ?? null},
      ${rule.rate.numerator}, ${rule.rate.denominator}, ${rule.formula},
      ${rule.sourceLocator}, ${definitionDigest}
    )`
    return id
  }
}

function toTaxRule(row: postgres.Row): TaxRule {
  const optional = (value: unknown) => (value === '*' ? undefined : String(value))
  const operation = optional(row.operation)
  const issuerEstablishmentId = optional(row.issuer_establishment_id)
  const issuerRegime = optional(row.issuer_regime)
  const recipientRegime = optional(row.recipient_regime)
  const originState = optional(row.origin_state)
  const destinationState = optional(row.destination_state)
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
      ...(recipientRegime ? { recipientRegime } : {}),
      ...(originState ? { originState } : {}),
      ...(destinationState ? { destinationState } : {}),
      ...(subjectKind
        ? { subject: { kind: subjectKind as 'item' | 'service', id: String(row.subject_id) } }
        : {}),
      ...(classificationKind
        ? {
            classification: {
              kind: classificationKind as 'ncm' | 'cest' | 'service' | 'origin',
              code: String(row.classification_code),
            },
          }
        : {}),
    },
    rate: { numerator: String(row.rate_numerator), denominator: String(row.rate_denominator) },
    formula: row.formula as TaxRule['formula'],
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

function missingApprovedReference(
  input: FiscalCalculationInput,
  rows: postgres.Row[],
): string | null {
  for (const line of input.lines) {
    const expected: Array<{ family: string; code: string }> = []
    if (line.itemId && line.classifications.ncm)
      expected.push({ family: 'ncm', code: line.classifications.ncm })
    if (line.serviceId && line.classifications.service)
      expected.push({ family: 'service', code: line.classifications.service })
    if (line.classifications.cest)
      expected.push({ family: 'cest', code: line.classifications.cest })
    for (const classification of expected) {
      const valid = rows.some(
        (row) =>
          row.family === classification.family &&
          row.code === classification.code &&
          (row.model === '*' || row.model === input.model) &&
          (row.jurisdiction === '*' || row.jurisdiction === input.destination.stateCode) &&
          String(row.effective_from) <= input.issueDate &&
          (!row.effective_to || String(row.effective_to) > input.issueDate),
      )
      if (!valid) return `${classification.family}:${classification.code}`
    }
  }
  return null
}
