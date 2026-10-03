import { createHash, randomUUID } from 'node:crypto'
import { businessDayOf, fiscalServiceOriginRequestSchema, moneySchema } from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from '../audit'
import type { OwnerFiscalClient } from '../backfill'
import { canonicalDigest, canonicalJson } from '../canonical-json'
import type { FiscalCapabilities } from '../capabilities'
import { openOrigin, sealOrigin } from '../origin-crypto'
import type { FiscalProjections } from '../projections'
import { MunicipalityUnsupported, ServiceProfileMissing, SourceKeyConflict } from './errors'
import { ibgeMunicipality } from './reference'
import type { FiscalNfseRegistry } from './registry'
import type { FiscalServiceProfiles } from './service-profiles'

export const NFSE_OPERATION = 'service-provision'
/** The reviewed rule window of the Phase 47 fixture (RTC V0057, 2026). */
const COMPETENCE_FROM = '2026-01-01'
const COMPETENCE_TO = '2027-01-01'

const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  idempotencyKey: z.string().min(16).max(128),
  actorId: z.string().min(1).max(200),
  request: fiscalServiceOriginRequestSchema,
})

/** The frozen, encrypted facts of one service provision. */
export const serviceOriginPayloadSchema = z.strictObject({
  originModule: z.literal('fiscal'),
  originDocumentType: z.literal('service'),
  originId: z.uuid(),
  purpose: z.literal('service'),
  customerId: z.uuid(),
  establishmentId: z.uuid(),
  issuerProfileRevision: z.number().int().positive(),
  recipientProfileRevision: z.number().int().positive(),
  municipalityCode: z.string().regex(/^\d{7}$/),
  lineId: z.uuid(),
  serviceItemId: z.uuid(),
  serviceProfileRevision: z.number().int().positive(),
  nationalTaxCode: z.string().regex(/^\d{6}$/),
  nbsCode: z.string().regex(/^\d{9}$/),
  municipalTaxCode: z.string().min(1).max(20).nullable(),
  competenceDate: z.iso.date(),
  description: z.string().min(1).max(2000),
  amount: moneySchema,
  sourceKey: z
    .strictObject({
      module: z.string(),
      documentType: z.string(),
      id: z.uuid(),
      period: z.string(),
    })
    .nullable(),
  reasonDigest: z.string().regex(/^[0-9a-f]{64}$/),
})

export type ServiceOriginPayload = z.infer<typeof serviceOriginPayloadSchema>

export type ServiceOriginResult = {
  id: string
  digest: string
  createdAt: string
  existing: boolean
}

/**
 * Freezes a reviewed service provision. It never creates a receivable: Financial owns
 * money, and Phase K will send contract periods through the same source key.
 */
export class FiscalServiceOrigins {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly masterKey: Buffer,
    private readonly projections: Pick<FiscalProjections, 'readIssuer' | 'readParty'>,
    private readonly capabilities: Pick<FiscalCapabilities, 'listActive'>,
    private readonly profiles: Pick<FiscalServiceProfiles, 'read' | 'effective'>,
    private readonly registry: Pick<FiscalNfseRegistry, 'resolve'>,
    private readonly ownerForTenant: (tenantId: string) => Pick<OwnerFiscalClient, 'catalogItem'>,
    private readonly today: () => string = () => businessDayOf(new Date()),
  ) {
    if (masterKey.length !== 32) throw new Error('Fiscal service-origin key must be 32 bytes')
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async create(input: z.input<typeof commandSchema>): Promise<ServiceOriginResult> {
    const command = commandSchema.parse(input)
    const { request } = command
    const requestDigest = canonicalDigest(request)
    const prior = await this.findPrior(command.tenantId, command.idempotencyKey, request)
    if (prior) {
      if (prior.requestDigest !== requestDigest)
        throw prior.bySource
          ? new SourceKeyConflict('The source key was already frozen with different facts')
          : new Error('Conflicting Fiscal service-origin idempotency key')
      return { id: prior.id, digest: prior.digest, createdAt: prior.createdAt, existing: true }
    }
    const payload = await this.freeze(command)
    const plaintext = canonicalJson(payload)
    const digest = createHash('sha256').update(plaintext).digest('hex')
    const ciphertext = sealOrigin(this.masterKey, command.tenantId, payload.originId, plaintext)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${command.tenantId}, true)`
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${command.tenantId}:service-origin:${command.idempotencyKey}`}, 0))`
      if (request.sourceKey)
        await tx`select pg_advisory_xact_lock(hashtextextended(${`${command.tenantId}:service-source:${canonicalDigest(request.sourceKey)}`}, 0))`
      const raced = await findPriorIn(tx, command.tenantId, command.idempotencyKey, request)
      if (raced) {
        if (raced.requestDigest !== requestDigest)
          throw raced.bySource
            ? new SourceKeyConflict('The source key was already frozen with different facts')
            : new Error('Conflicting Fiscal service-origin idempotency key')
        await recordKey(tx, command, raced.requestDigest, raced.id)
        return { id: raced.id, digest: raced.digest, createdAt: raced.createdAt, existing: true }
      }
      await tx`insert into fiscal_service_origins (
          id, tenant_id, establishment_id, issuer_profile_revision, recipient_party_id,
          recipient_profile_revision, service_item_id, service_profile_revision,
          municipality_code, competence_date, amount_minor, currency, source_module, source_document_type,
          source_id, source_period, request_digest, actor_id, reason_digest,
          payload_ciphertext, payload_digest
        ) values (
          ${payload.originId}, ${command.tenantId}, ${payload.establishmentId},
          ${payload.issuerProfileRevision}, ${payload.customerId},
          ${payload.recipientProfileRevision}, ${payload.serviceItemId},
          ${payload.serviceProfileRevision}, ${payload.municipalityCode},
          ${payload.competenceDate},
          ${payload.amount.amount}, 'BRL', ${request.sourceKey?.module ?? null},
          ${request.sourceKey?.documentType ?? null}, ${request.sourceKey?.id ?? null},
          ${request.sourceKey?.period ?? null}, ${requestDigest}, ${command.actorId},
          ${payload.reasonDigest}, ${ciphertext}, ${digest}
        )`
      await recordKey(tx, command, requestDigest, payload.originId)
      await appendAudit(tx, {
        tenantId: command.tenantId,
        actorId: command.actorId,
        action: 'service-origin.created',
        resourceId: payload.originId,
        detail: { payloadDigest: digest, sourceKey: request.sourceKey ?? null },
      })
      const [saved] = await tx`select created_at from fiscal_service_origins
        where tenant_id = ${command.tenantId} and id = ${payload.originId}`
      return {
        id: payload.originId,
        digest,
        createdAt: new Date(saved?.created_at).toISOString(),
        existing: false,
      }
    })
  }

  /** Reads and verifies a frozen service origin. */
  async open(
    tx: postgres.TransactionSql,
    tenantId: string,
    originId: string,
  ): Promise<{ plaintext: string; digest: string; payload: ServiceOriginPayload }> {
    const [origin] = await tx`select payload_ciphertext, payload_digest from fiscal_service_origins
      where tenant_id = ${tenantId} and id = ${originId}`
    if (!origin) throw new Error('Fiscal service origin not found')
    const plaintext = openOrigin(
      this.masterKey,
      tenantId,
      originId,
      Buffer.from(origin.payload_ciphertext),
    )
    const digest = createHash('sha256').update(plaintext).digest('hex')
    if (digest !== origin.payload_digest) throw new Error('Fiscal service-origin digest mismatch')
    const payload = serviceOriginPayloadSchema.parse(JSON.parse(plaintext))
    if (payload.originId !== originId) throw new Error('Fiscal service-origin identity mismatch')
    return { plaintext, digest, payload }
  }

  private async freeze(command: z.infer<typeof commandSchema>): Promise<ServiceOriginPayload> {
    const { request, tenantId } = command
    if (request.competenceDate < COMPETENCE_FROM || request.competenceDate >= COMPETENCE_TO)
      throw new Error('Fiscal service competence date is outside the reviewed rule window')
    if (request.competenceDate > this.today())
      throw new Error('Fiscal service competence date is in the future (E0015)')
    if (request.amount.currency !== 'BRL' || !/^[1-9]\d{0,14}$/.test(request.amount.amount))
      throw new Error('Fiscal service amount is unsupported')
    const [issuer, recipient, profile, effective] = await Promise.all([
      this.projections.readIssuer(tenantId, request.issuerProfileRevision),
      this.projections.readParty(
        tenantId,
        request.recipientPartyId,
        request.recipientProfileRevision,
      ),
      this.profiles.read(tenantId, request.serviceItemId, request.serviceProfileRevision),
      this.profiles.effective(tenantId, request.serviceItemId, request.competenceDate),
    ])
    if (!issuer || !recipient)
      throw new Error('Fiscal service owner revisions are unavailable or unsupported')
    if (!profile || effective?.revision !== profile.revision)
      throw new ServiceProfileMissing(
        'The service profile revision is not the one in force at the competence date',
      )
    const municipalityCode = assertIssuer(issuer)
    assertRecipient(recipient)
    const item = z
      .object({ id: z.uuid(), kind: z.literal('service'), active: z.literal(true) })
      .safeParse(await this.ownerForTenant(tenantId).catalogItem(request.serviceItemId))
    if (!item.success || item.data.id !== request.serviceItemId)
      throw new Error('Fiscal service origin needs an active Catalog service item')
    const capability = (await this.capabilities.listActive(tenantId)).find(
      (row) =>
        row.model === 'nfse' &&
        row.environment === 'simulation' &&
        row.establishmentId === request.establishmentId &&
        row.jurisdictionKind === 'municipality' &&
        row.jurisdictionCode === municipalityCode &&
        row.operation === NFSE_OPERATION,
    )
    if (!capability) throw new Error('Fiscal capability is unsupported for this municipality')
    const resolution = await this.registry.resolve(
      tenantId,
      municipalityCode,
      request.competenceDate,
    )
    if (resolution.route !== 'national')
      throw new MunicipalityUnsupported(resolution.reason ?? 'Municipality is unsupported')
    const originId = randomUUID()
    return serviceOriginPayloadSchema.parse({
      originModule: 'fiscal',
      originDocumentType: 'service',
      originId,
      purpose: 'service',
      customerId: request.recipientPartyId,
      establishmentId: request.establishmentId,
      issuerProfileRevision: request.issuerProfileRevision,
      recipientProfileRevision: request.recipientProfileRevision,
      municipalityCode,
      lineId: randomUUID(),
      serviceItemId: request.serviceItemId,
      serviceProfileRevision: profile.revision,
      nationalTaxCode: profile.nationalTaxCode,
      nbsCode: profile.nbsCode,
      municipalTaxCode: profile.municipalTaxCode,
      competenceDate: request.competenceDate,
      description: request.description,
      amount: request.amount,
      sourceKey: request.sourceKey ?? null,
      reasonDigest: createHash('sha256').update(request.reason).digest('hex'),
    })
  }

  private async findPrior(
    tenantId: string,
    idempotencyKey: string,
    request: z.infer<typeof fiscalServiceOriginRequestSchema>,
  ) {
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return findPriorIn(tx, tenantId, idempotencyKey, request)
    })
  }
}

async function findPriorIn(
  tx: postgres.TransactionSql,
  tenantId: string,
  idempotencyKey: string,
  request: z.infer<typeof fiscalServiceOriginRequestSchema>,
): Promise<{
  id: string
  digest: string
  createdAt: string
  requestDigest: string
  bySource: boolean
} | null> {
  const [byKey] = await tx`select origin.id, origin.payload_digest, origin.created_at,
      record.request_digest
    from fiscal_service_origin_idempotency record
    join fiscal_service_origins origin on origin.tenant_id = record.tenant_id
      and origin.id = record.origin_id
    where record.tenant_id = ${tenantId} and record.idempotency_key = ${idempotencyKey}`
  if (byKey)
    return {
      id: String(byKey.id),
      digest: String(byKey.payload_digest),
      createdAt: new Date(byKey.created_at).toISOString(),
      requestDigest: String(byKey.request_digest),
      bySource: false,
    }
  if (!request.sourceKey) return null
  const [bySource] = await tx`select id, payload_digest, created_at, request_digest
    from fiscal_service_origins where tenant_id = ${tenantId}
      and source_module = ${request.sourceKey.module}
      and source_document_type = ${request.sourceKey.documentType}
      and source_id = ${request.sourceKey.id} and source_period = ${request.sourceKey.period}`
  if (!bySource) return null
  return {
    id: String(bySource.id),
    digest: String(bySource.payload_digest),
    createdAt: new Date(bySource.created_at).toISOString(),
    requestDigest: String(bySource.request_digest),
    bySource: true,
  }
}

async function recordKey(
  tx: postgres.TransactionSql,
  command: z.infer<typeof commandSchema>,
  requestDigest: string,
  originId: string,
): Promise<void> {
  await tx`insert into fiscal_service_origin_idempotency (
      tenant_id, idempotency_key, request_digest, origin_id
    ) values (
      ${command.tenantId}, ${command.idempotencyKey}, ${requestDigest}, ${originId}
    ) on conflict do nothing`
}

/** A provider outside the Simples Nacional with a numeric CNPJ in an IBGE municipality. */
export function assertIssuer(
  issuer: NonNullable<Awaited<ReturnType<FiscalProjections['readIssuer']>>>,
): string {
  const municipalityCode = issuer.company.address.municipalityCode
  if (
    issuer.company.baseCurrency !== 'BRL' ||
    !['lucro-real', 'lucro-presumido'].includes(issuer.company.fiscalRegime)
  )
    throw new Error('Fiscal capability is unsupported for this issuer regime')
  if (!issuer.company.taxId || !/^\d{14}$/.test(issuer.company.taxId))
    throw new Error('Fiscal capability is unsupported: NFS-e layout 1.01 takes a numeric CNPJ')
  if (!municipalityCode || !ibgeMunicipality(municipalityCode))
    throw new MunicipalityUnsupported('The issuer has no IBGE municipality')
  return municipalityCode
}

export function assertRecipient(
  recipient: NonNullable<Awaited<ReturnType<FiscalProjections['readParty']>>>,
): void {
  const address = recipient.profile.address
  if (
    !/^\d{11}$|^\d{14}$/.test(recipient.taxId) ||
    address.country !== 'BR' ||
    !address.municipalityCode ||
    !ibgeMunicipality(address.municipalityCode) ||
    !/^\d{8}$/.test(address.postalCode.replace(/\D/g, ''))
  )
    throw new Error('Fiscal service recipient needs a numeric CPF or CNPJ and a national address')
}
