import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'

const digest = z.string().regex(/^[0-9a-f]{64}$/)
const definitionSchema = z.object({
  tenantId: z.uuid(),
  model: z.enum(['55', '65', 'nfse']),
  environment: z.enum(['simulation', 'homologation', 'production']),
  establishmentId: z.uuid(),
  jurisdictionKind: z.enum(['uf', 'municipality', 'national']),
  jurisdictionCode: z.string().min(2).max(20),
  operation: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  adapterVersion: z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/),
  sourceManifestDigest: digest,
  schemaPackageDigest: digest,
  calculationFixtureId: z.string().min(1).max(160),
  createdBy: z.string().min(1).max(200),
})

const reviewSchema = z.object({
  tenantId: z.uuid(),
  capabilityId: z.uuid(),
  approved: z.boolean(),
  reviewedBy: z.string().min(1).max(200),
  interpretation: z.string().min(10).max(4000),
  reviewedAt: z.iso.datetime({ offset: true }),
})

const activationSchema = z.object({
  tenantId: z.uuid(),
  capabilityId: z.uuid(),
  action: z.enum(['activate_simulated', 'activate_homologated', 'deactivate']),
  evidenceDigest: digest,
  actorId: z.string().min(1).max(200),
  reason: z.string().min(10).max(1000),
  occurredAt: z.iso.datetime({ offset: true }),
})

const homologationEvidenceSchema = z.object({
  tenantId: z.uuid(),
  capabilityId: z.uuid(),
  sourceManifestDigest: digest,
  endpointSetDigest: digest,
  certificateFingerprint: digest,
  roundTripDigest: digest,
  reviewedBy: z.string().min(1).max(200),
  reviewedAt: z.iso.datetime({ offset: true }),
})

export type FiscalCapabilityDefinition = z.infer<typeof definitionSchema>
export type ActiveFiscalCapability = Omit<FiscalCapabilityDefinition, 'createdBy'> & {
  id: string
  status: 'simulated' | 'homologated'
  activatedAt: string
  evidenceDigest: string
}

export class FiscalCapabilities {
  readonly #db: ReturnType<typeof postgres>

  constructor(databaseUrl: string) {
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async register(input: FiscalCapabilityDefinition): Promise<{ id: string; existing: boolean }> {
    const value = definitionSchema.parse(input)
    validateJurisdiction(value)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const id = randomUUID()
      const inserted = await tx`insert into fiscal_capability_definitions (
        id, tenant_id, model, environment, establishment_id, jurisdiction_kind,
        jurisdiction_code, operation, adapter_version, source_manifest_digest,
        schema_package_digest, calculation_fixture_id, created_by
      ) values (
        ${id}, ${value.tenantId}, ${value.model}, ${value.environment},
        ${value.establishmentId}, ${value.jurisdictionKind}, ${value.jurisdictionCode},
        ${value.operation}, ${value.adapterVersion}, ${value.sourceManifestDigest},
        ${value.schemaPackageDigest}, ${value.calculationFixtureId}, ${value.createdBy}
      ) on conflict on constraint fiscal_capability_definition_key do nothing returning id`
      if (inserted.length > 0) return { id, existing: false }
      const [existing] = await tx`select id, source_manifest_digest, schema_package_digest,
        calculation_fixture_id, created_by from fiscal_capability_definitions
        where tenant_id = ${value.tenantId} and model = ${value.model}
          and environment = ${value.environment} and establishment_id = ${value.establishmentId}
          and jurisdiction_kind = ${value.jurisdictionKind}
          and jurisdiction_code = ${value.jurisdictionCode} and operation = ${value.operation}
          and adapter_version = ${value.adapterVersion}`
      if (
        !existing ||
        existing.source_manifest_digest !== value.sourceManifestDigest ||
        existing.schema_package_digest !== value.schemaPackageDigest ||
        existing.calculation_fixture_id !== value.calculationFixtureId ||
        existing.created_by !== value.createdBy
      )
        throw new Error('Conflicting Fiscal capability definition')
      return { id: String(existing.id), existing: true }
    })
  }

  async review(input: z.input<typeof reviewSchema>): Promise<{ id: string; existing: boolean }> {
    const value = reviewSchema.parse(input)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const id = randomUUID()
      const inserted = await tx`insert into fiscal_capability_reviews (
        id, tenant_id, capability_id, approved, reviewed_by, interpretation, reviewed_at
      ) values (
        ${id}, ${value.tenantId}, ${value.capabilityId}, ${value.approved},
        ${value.reviewedBy}, ${value.interpretation}, ${value.reviewedAt}
      ) on conflict on constraint fiscal_capability_review_once do nothing returning id`
      if (inserted.length > 0) return { id, existing: false }
      const [existing] = await tx`select id, approved, reviewed_by, interpretation, reviewed_at
        from fiscal_capability_reviews where tenant_id = ${value.tenantId}
          and capability_id = ${value.capabilityId}`
      if (
        !existing ||
        existing.approved !== value.approved ||
        existing.reviewed_by !== value.reviewedBy ||
        existing.interpretation !== value.interpretation ||
        new Date(existing.reviewed_at).toISOString() !== value.reviewedAt
      )
        throw new Error('Conflicting Fiscal capability review')
      return { id: String(existing.id), existing: true }
    })
  }

  async change(
    input: z.input<typeof activationSchema>,
  ): Promise<{ id: string; existing: boolean }> {
    const value = activationSchema.parse(input)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const id = randomUUID()
      const inserted = await tx`insert into fiscal_capability_activation_events (
        id, tenant_id, capability_id, action, evidence_digest, actor_id, reason, occurred_at
      ) values (
        ${id}, ${value.tenantId}, ${value.capabilityId}, ${value.action},
        ${value.evidenceDigest}, ${value.actorId}, ${value.reason}, ${value.occurredAt}
      ) on conflict on constraint fiscal_capability_activation_idempotent do nothing returning id`
      if (inserted.length > 0) return { id, existing: false }
      const [existing] = await tx`select id, actor_id, reason, occurred_at
        from fiscal_capability_activation_events where tenant_id = ${value.tenantId}
          and capability_id = ${value.capabilityId} and action = ${value.action}
          and evidence_digest = ${value.evidenceDigest}`
      if (
        !existing ||
        existing.actor_id !== value.actorId ||
        existing.reason !== value.reason ||
        new Date(existing.occurred_at).toISOString() !== value.occurredAt
      )
        throw new Error('Conflicting Fiscal capability activation')
      return { id: String(existing.id), existing: true }
    })
  }

  async recordHomologationEvidence(
    input: z.input<typeof homologationEvidenceSchema>,
  ): Promise<{ id: string; existing: boolean }> {
    const value = homologationEvidenceSchema.parse(input)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const id = randomUUID()
      const inserted = await tx`insert into fiscal_capability_homologation_evidence (
          id, tenant_id, capability_id, source_manifest_digest, endpoint_set_digest,
          certificate_fingerprint, round_trip_digest, reviewed_by, reviewed_at
        ) values (
          ${id}, ${value.tenantId}, ${value.capabilityId}, ${value.sourceManifestDigest},
          ${value.endpointSetDigest}, ${value.certificateFingerprint},
          ${value.roundTripDigest}, ${value.reviewedBy}, ${value.reviewedAt}
        ) on conflict on constraint fiscal_homologation_evidence_once do nothing returning id`
      if (inserted.length > 0) return { id, existing: false }
      const [existing] = await tx`select id, source_manifest_digest, endpoint_set_digest,
          certificate_fingerprint, round_trip_digest, reviewed_by, reviewed_at
        from fiscal_capability_homologation_evidence
        where tenant_id = ${value.tenantId} and capability_id = ${value.capabilityId}`
      if (
        !existing ||
        existing.source_manifest_digest !== value.sourceManifestDigest ||
        existing.endpoint_set_digest !== value.endpointSetDigest ||
        existing.certificate_fingerprint !== value.certificateFingerprint ||
        existing.round_trip_digest !== value.roundTripDigest ||
        existing.reviewed_by !== value.reviewedBy ||
        new Date(existing.reviewed_at).toISOString() !== value.reviewedAt
      )
        throw new Error('Conflicting Fiscal homologation evidence')
      return { id: String(existing.id), existing: true }
    })
  }

  async listActive(tenantId: string): Promise<ActiveFiscalCapability[]> {
    z.uuid().parse(tenantId)
    const rows = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select definition.*, latest.evidence_digest, latest.occurred_at
        from fiscal_capability_definitions definition
        join lateral (
          select action, evidence_digest, occurred_at
          from fiscal_capability_activation_events event
          where event.tenant_id = definition.tenant_id
            and event.capability_id = definition.id
          order by event.created_at desc, event.id desc limit 1
        ) latest on latest.action in ('activate_simulated', 'activate_homologated')
        where definition.tenant_id = ${tenantId}
        order by definition.model, definition.environment, definition.establishment_id,
          definition.jurisdiction_code, definition.operation`
    })
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      model: row.model as ActiveFiscalCapability['model'],
      environment: row.environment as ActiveFiscalCapability['environment'],
      establishmentId: String(row.establishment_id),
      jurisdictionKind: row.jurisdiction_kind as ActiveFiscalCapability['jurisdictionKind'],
      jurisdictionCode: String(row.jurisdiction_code),
      operation: String(row.operation),
      adapterVersion: String(row.adapter_version),
      sourceManifestDigest: String(row.source_manifest_digest),
      schemaPackageDigest: String(row.schema_package_digest),
      calculationFixtureId: String(row.calculation_fixture_id),
      status: row.environment === 'homologation' ? 'homologated' : 'simulated',
      activatedAt: new Date(row.occurred_at).toISOString(),
      evidenceDigest: String(row.evidence_digest),
    }))
  }
}

function validateJurisdiction(value: FiscalCapabilityDefinition): void {
  if (value.model === 'nfse') {
    if (value.jurisdictionKind === 'uf') throw new Error('NFS-e requires a municipal scope')
    return
  }
  if (value.jurisdictionKind !== 'uf' || !/^[A-Z]{2}$/.test(value.jurisdictionCode))
    throw new Error('NF-e/NFC-e requires a two-letter UF scope')
}
