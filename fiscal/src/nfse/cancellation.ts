import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalArtifacts } from '../artifacts'
import { canonicalDigest } from '../canonical-json'
import type { FiscalDispatch } from '../dispatch'
import type { FiscalDocuments } from '../documents'
import { zonedInstant } from '../nfe-values'
import type { SimulationCredential } from '../nfe55/signature'
import { ServiceCancellationWindowElapsed } from './errors'
import { serializeCancellationRequest } from './event'
import type { ServiceProfile } from './issuance'
import { NFSE_SOURCE_SCHEMA } from './issuance'
import { validateNfseSchema } from './schema'
import { signNfseElement, verifyNfseElement } from './signature'

const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  idempotencyKey: z.string().min(16).max(128),
  actorId: z.string().min(1).max(200),
  reasonCode: z.enum(['1', '2', '9']),
  reason: z.string().trim().min(15).max(255),
})

const DAY = 86_400_000

/**
 * Event 101101. It is signed and frozen before the durable worker boundary, and allowed
 * only inside the municipality's window (E0822), counted from the NFS-e `dhProc`.
 */
export class FiscalServiceCancellation {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly documents: Pick<FiscalDocuments, 'get'>,
    private readonly artifacts: Pick<FiscalArtifacts, 'put'>,
    private readonly dispatch: Pick<FiscalDispatch, 'findCancellation' | 'queueCancellation'>,
    private readonly profile: ServiceProfile,
    private readonly credential: SimulationCredential,
    private readonly schemaZip: Buffer,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#db = postgres(databaseUrl, { max: 3, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async request(input: z.input<typeof commandSchema>) {
    const command = commandSchema.parse(input)
    const requestDigest = canonicalDigest({
      documentId: command.documentId,
      reasonCode: command.reasonCode,
      reason: command.reason,
    })
    const prior = await this.dispatch.findCancellation(
      command.tenantId,
      command.documentId,
      command.idempotencyKey,
    )
    if (prior) {
      if (prior.requestDigest !== requestDigest)
        throw new Error('Conflicting Fiscal dispatch idempotency key')
      return accepted(prior.commandId, command.documentId, prior.status, true)
    }
    const document = await this.documents.get(command.tenantId, command.documentId)
    if (!document) throw new Error('Fiscal document not found')
    if (document.model !== 'nfse' || document.environment !== 'simulation')
      throw new Error('Unsupported Fiscal cancellation tuple')
    if (document.status !== 'authorized') throw new Error('Fiscal cancellation is not allowed')
    const facts = await this.readFacts(command.tenantId, command.documentId)
    if (facts.capabilityId !== this.profile.capabilityId)
      throw new Error('Fiscal cancellation capability is inactive')
    if (facts.liveSubstitute)
      throw new Error('Fiscal cancellation is blocked by a pending NFS-e substitution')
    const windowMs = this.profile.cancellationWindowDays * DAY
    if (this.now().getTime() - Date.parse(facts.processedAt) > windowMs)
      throw new ServiceCancellationWindowElapsed(this.profile.cancellationWindowDays)
    const unsigned = serializeCancellationRequest({
      nfseKey: facts.nfseKey,
      authorCnpj: facts.providerCnpj,
      occurredAt: zonedInstant(this.now().toISOString(), 'America/Sao_Paulo'),
      applicationVersion: 'horizon-phase47',
      reasonCode: command.reasonCode,
      reason: command.reason,
    })
    const signed = signNfseElement(unsigned, 'infPedReg', this.credential)
    verifyNfseElement(signed, 'infPedReg', this.credential.certificate)
    await validateNfseSchema({ xml: signed, root: 'pedRegEvento', schemaZip: this.schemaZip })
    const artifact = await this.artifacts.put(
      {
        tenantId: command.tenantId,
        documentId: command.documentId,
        kind: 'cancellation_request',
        mediaType: 'application/xml',
        sourceSchema: NFSE_SOURCE_SCHEMA,
      },
      signed,
    )
    const queued = await this.dispatch.queueCancellation({
      tenantId: command.tenantId,
      documentId: command.documentId,
      idempotencyKey: command.idempotencyKey,
      requestDigest,
      artifactDigest: artifact.digest,
      actorId: command.actorId,
    })
    return accepted(queued.commandId, command.documentId, queued.status, queued.existing)
  }

  private async readFacts(tenantId: string, documentId: string) {
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select generation.nfse_key, generation.processed_at, binding.capability_id,
          exists (select 1 from fiscal_documents substitute
            where substitute.tenant_id = generation.tenant_id
              and substitute.substitutes_document_id = generation.document_id
              and substitute.status not in ('rejected', 'cancelled')) as live_substitute
        from fiscal_nfse_generations generation
        join fiscal_document_issuance_bindings binding on binding.tenant_id = generation.tenant_id
          and binding.document_id = generation.document_id
        join lateral (
          select event.action from fiscal_capability_activation_events event
          where event.tenant_id = binding.tenant_id and event.capability_id = binding.capability_id
          order by event.created_at desc, event.id desc limit 1
        ) latest on latest.action = 'activate_simulated'
        where generation.tenant_id = ${tenantId} and generation.document_id = ${documentId}`
    })
    if (!row) throw new Error('Fiscal cancellation capability is inactive or NFS-e unavailable')
    const nfseKey = String(row.nfse_key)
    return {
      nfseKey,
      // The key carries the provider's inscription (positions 10–23).
      providerCnpj: nfseKey.slice(9, 23),
      processedAt: new Date(row.processed_at).toISOString(),
      capabilityId: String(row.capability_id),
      liveSubstitute: Boolean(row.live_substitute),
    }
  }
}

function accepted(commandId: string, documentId: string, status: string, existing: boolean) {
  return {
    commandId,
    documentId,
    status,
    statusUrl: `/fiscal/service-documents/${documentId}`,
    simulated: true as const,
    existing,
  }
}
