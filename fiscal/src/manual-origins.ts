import { createHash, randomUUID } from 'node:crypto'
import { fiscalManualOriginRequestSchema } from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from './audit'
import type { OwnerFiscalClient } from './backfill'
import { canonicalDigest, canonicalJson } from './canonical-json'
import type { FiscalCapabilities } from './capabilities'
import { decimal, integer, multiply, roundHalfAwayFromZero } from './exact-decimal'
import { sealOrigin } from './origin-crypto'
import { type ManualOriginPayload, manualOriginPayloadSchema } from './origin-snapshot'
import { PHASE41_FIXTURE_ID } from './phase41-approved-scenario'
import type { FiscalProjections } from './projections'

const commandSchema = fiscalManualOriginRequestSchema.extend({
  tenantId: z.uuid(),
  idempotencyKey: z.string().min(16).max(128),
  actorId: z.string().min(1).max(200),
})
const itemSchema = z.object({
  id: z.uuid(),
  kind: z.literal('product'),
  name: z.string().min(1).max(160),
  active: z.literal(true),
})

/** Freezes owner-approved revisions and operator commercial input for simulation only. */
export class FiscalManualOrigins {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly masterKey: Buffer,
    private readonly projections: Pick<
      FiscalProjections,
      'readIssuer' | 'readParty' | 'resolveClassification'
    >,
    private readonly capabilities: Pick<FiscalCapabilities, 'listActive'>,
    private readonly ownerForTenant: (tenantId: string) => Pick<OwnerFiscalClient, 'catalogItem'>,
  ) {
    if (masterKey.length !== 32) throw new Error('Fiscal manual-origin key must be 32 bytes')
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async create(input: z.input<typeof commandSchema>) {
    const command = commandSchema.parse(input)
    const requestDigest = canonicalDigest({
      tenantId: command.tenantId,
      establishmentId: command.establishmentId,
      issuerProfileRevision: command.issuerProfileRevision,
      recipientPartyId: command.recipientPartyId,
      recipientProfileRevision: command.recipientProfileRevision,
      issueDate: command.issueDate,
      operation: command.operation,
      purpose: command.purpose,
      reason: command.reason,
      lines: command.lines,
    })
    const prior = await this.findByKey(command.tenantId, command.idempotencyKey)
    if (prior) return verifyPrior(prior, requestDigest)

    if (command.issueDate < '2026-01-01' || command.issueDate >= '2027-01-01')
      throw new Error('Fiscal manual-origin date is unsupported')
    const capability = (await this.capabilities.listActive(command.tenantId)).find(
      (row) =>
        row.model === '55' &&
        row.environment === 'simulation' &&
        row.establishmentId === command.establishmentId &&
        row.jurisdictionKind === 'uf' &&
        row.jurisdictionCode === 'SP' &&
        row.operation === 'normal-sale' &&
        row.calculationFixtureId === PHASE41_FIXTURE_ID,
    )
    if (!capability) throw new Error('Fiscal capability is unsupported')
    const [issuer, recipient] = await Promise.all([
      this.projections.readIssuer(command.tenantId, command.issuerProfileRevision),
      this.projections.readParty(
        command.tenantId,
        command.recipientPartyId,
        command.recipientProfileRevision,
      ),
    ])
    if (
      !issuer ||
      !recipient ||
      issuer.effectiveFrom > command.issueDate ||
      recipient.profile.effectiveFrom > command.issueDate ||
      issuer.company.address.state !== 'SP' ||
      recipient.profile.address.state !== 'SP' ||
      issuer.company.baseCurrency !== 'BRL' ||
      !['lucro-real', 'lucro-presumido'].includes(issuer.company.fiscalRegime)
    )
      throw new Error('Fiscal manual-origin owner revisions are unavailable or unsupported')

    const itemNames = new Map<string, string>()
    const ids = new Set<string>()
    const lines: ManualOriginPayload['lines'] = []
    let total = 0n
    for (const line of command.lines) {
      if (ids.has(line.lineId)) throw new Error('Duplicate Fiscal manual line ID')
      ids.add(line.lineId)
      if (line.unitPrice.currency !== 'BRL' || BigInt(line.unitPrice.amount) < 0n)
        throw new Error('Fiscal manual line price is unsupported')
      const classification = await this.projections.resolveClassification(
        command.tenantId,
        line.itemId,
        command.issueDate,
      )
      if (
        !classification ||
        classification.revision !== line.catalogRevision ||
        classification.ncm !== '09012100'
      )
        throw new Error('Fiscal manual line classification is unsupported')
      let description = itemNames.get(line.itemId)
      if (!description) {
        const item = itemSchema.parse(
          await this.ownerForTenant(command.tenantId).catalogItem(line.itemId),
        )
        if (item.id !== line.itemId) throw new Error('Catalog item identity mismatch')
        description = item.name
        itemNames.set(line.itemId, description)
      }
      const amount = roundHalfAwayFromZero(
        multiply(decimal(line.quantity), integer(BigInt(line.unitPrice.amount))),
      )
      if (amount <= 0n || amount > 999_999_999_999_999n)
        throw new Error('Fiscal manual line amount is unsupported')
      total += amount
      lines.push({
        lineId: line.lineId,
        itemId: line.itemId,
        catalogRevision: line.catalogRevision,
        description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: { amount: String(amount), currency: 'BRL' },
      })
    }
    const id = randomUUID()
    const payload = manualOriginPayloadSchema.parse({
      originModule: 'fiscal',
      originDocumentType: 'manual-simulation',
      originId: id,
      purpose: 'manual',
      customerId: command.recipientPartyId,
      establishmentId: command.establishmentId,
      issueDate: command.issueDate,
      issuerProfileRevision: command.issuerProfileRevision,
      recipientProfileRevision: command.recipientProfileRevision,
      reasonDigest: createHash('sha256').update(command.reason).digest('hex'),
      lines,
      total: { amount: String(total), currency: 'BRL' },
    })
    const plaintext = canonicalJson(payload)
    const digest = createHash('sha256').update(plaintext).digest('hex')
    const ciphertext = sealOrigin(this.masterKey, command.tenantId, id, plaintext)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${command.tenantId}, true)`
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${command.tenantId}:${command.idempotencyKey}`}, 0))`
      const [existing] = await tx`select record.request_digest, record.origin_id,
          origin.payload_digest, origin.created_at
        from fiscal_manual_origin_idempotency record
        join fiscal_manual_origins origin on origin.tenant_id = record.tenant_id
          and origin.id = record.origin_id
        where record.tenant_id = ${command.tenantId}
          and record.idempotency_key = ${command.idempotencyKey}`
      if (existing)
        return verifyPrior(
          {
            requestDigest: String(existing.request_digest),
            id: String(existing.origin_id),
            digest: String(existing.payload_digest),
            createdAt: new Date(existing.created_at).toISOString(),
          },
          requestDigest,
        )
      await tx`insert into fiscal_manual_origins (
        id, tenant_id, establishment_id, issuer_profile_revision,
        recipient_party_id, recipient_profile_revision, issue_date,
        actor_id, reason_digest, payload_ciphertext, payload_digest
      ) values (
        ${id}, ${command.tenantId}, ${command.establishmentId},
        ${command.issuerProfileRevision}, ${command.recipientPartyId},
        ${command.recipientProfileRevision}, ${command.issueDate},
        ${command.actorId}, ${payload.reasonDigest}, ${ciphertext}, ${digest}
      )`
      await tx`insert into fiscal_manual_origin_idempotency (
        tenant_id, idempotency_key, request_digest, origin_id
      ) values (
        ${command.tenantId}, ${command.idempotencyKey}, ${requestDigest}, ${id}
      )`
      await appendAudit(tx, {
        tenantId: command.tenantId,
        actorId: command.actorId,
        action: 'manual-origin.created',
        resourceId: id,
        detail: { payloadDigest: digest, capabilityId: capability.id },
      })
      const [saved] = await tx`select created_at from fiscal_manual_origins
        where tenant_id = ${command.tenantId} and id = ${id}`
      return { id, digest, createdAt: new Date(saved?.created_at).toISOString() }
    })
  }

  private async findByKey(tenantId: string, key: string) {
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select record.request_digest, record.origin_id, origin.payload_digest,
          origin.created_at from fiscal_manual_origin_idempotency record
        join fiscal_manual_origins origin on origin.tenant_id = record.tenant_id
          and origin.id = record.origin_id
        where record.tenant_id = ${tenantId} and record.idempotency_key = ${key}`
    })
    if (!row) return null
    return {
      requestDigest: String(row.request_digest),
      id: String(row.origin_id),
      digest: String(row.payload_digest),
      createdAt: new Date(row.created_at).toISOString(),
    }
  }
}

function verifyPrior(
  prior: { requestDigest: string; id: string; digest: string; createdAt: string },
  requestDigest: string,
) {
  if (prior.requestDigest !== requestDigest)
    throw new Error('Conflicting Fiscal manual-origin idempotency key')
  return { id: prior.id, digest: prior.digest, createdAt: prior.createdAt }
}
