import { createHash } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalArtifacts } from './artifacts'
import { canonicalDigest } from './canonical-json'
import type { FiscalDispatch } from './dispatch'
import type { FiscalDocuments } from './documents'
import {
  serializeCancellationEvent,
  signCancellationEvent,
  validateCancellationEventSchema,
  verifyCancellationEventSignature,
} from './nfe55/cancellation-event'
import type { SimulationCredential } from './nfe55/signature'

const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  idempotencyKey: z.string().min(16).max(128),
  actorId: z.string().min(1).max(200),
  reason: z.string().trim().min(15).max(255),
})

/** Freezes a signed cancellation event before crossing the durable worker boundary. */
export class FiscalCancellation {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly documents: Pick<FiscalDocuments, 'get'>,
    private readonly artifacts: Pick<FiscalArtifacts, 'get' | 'put'>,
    private readonly dispatch: Pick<FiscalDispatch, 'findCancellation' | 'queueCancellation'>,
    private readonly credential: SimulationCredential,
    private readonly schemaZip: Buffer,
    private readonly schemaDigest: string,
  ) {
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async request(input: z.input<typeof commandSchema>) {
    const command = commandSchema.parse(input)
    return this.#db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('fiscal:cancellation:' || ${command.tenantId} || ':' || ${command.idempotencyKey}, 0))`
      await tx`select pg_advisory_xact_lock(hashtextextended('fiscal:cancellation:document:' || ${command.tenantId} || ':' || ${command.documentId}, 0))`
      await tx`select set_config('app.current_tenant', ${command.tenantId}, true)`
      return this.requestLocked(command, tx)
    })
  }

  private async requestLocked(command: z.infer<typeof commandSchema>, tx: postgres.TransactionSql) {
    const requestDigest = canonicalDigest({
      documentId: command.documentId,
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
      return {
        commandId: prior.commandId,
        documentId: command.documentId,
        status: prior.status,
        statusUrl: `/fiscal/documents/${command.documentId}`,
        simulated: true as const,
        existing: true,
      }
    }
    const document = await this.documents.get(command.tenantId, command.documentId)
    if (!document) throw new Error('Fiscal document not found')
    if (document.status !== 'authorized') throw new Error('Fiscal cancellation is not allowed')
    if (document.model !== '55' || document.environment !== 'simulation')
      throw new Error('Unsupported Fiscal cancellation tuple')
    const [evidence] = await tx`select binding.access_key, artifact.digest as protocol_digest
        from fiscal_document_issuance_bindings binding
        join lateral (
          select event.action from fiscal_capability_activation_events event
          where event.tenant_id = binding.tenant_id
            and event.capability_id = binding.capability_id
          order by event.created_at desc, event.id desc limit 1
        ) latest on latest.action = 'activate_simulated'
        join fiscal_artifacts artifact on artifact.tenant_id = binding.tenant_id
          and artifact.document_id = binding.document_id
          and artifact.kind = 'authorization_protocol'
        join fiscal_dispatch_observations observation
          on observation.tenant_id = artifact.tenant_id
          and observation.command_id = artifact.command_id
          and observation.protocol_digest = artifact.digest
          and observation.outcome = 'authorized'
        where binding.tenant_id = ${command.tenantId}
          and binding.document_id = ${command.documentId}
        order by artifact.created_at, artifact.id limit 1`
    if (!evidence)
      throw new Error('Fiscal cancellation capability is inactive or protocol unavailable')
    const protocol = await this.artifacts.get(
      command.tenantId,
      command.documentId,
      'authorization_protocol',
      String(evidence.protocol_digest),
    )
    const parsedProtocol = z
      .strictObject({
        schemaVersion: z.literal(1),
        simulated: z.literal(true),
        commandId: z.uuid(),
        statusCode: z.literal('100'),
        status: z.literal('authorized'),
        protocolNumber: z.string().regex(/^[0-9]{15}$/),
        providerCorrelation: z.string(),
      })
      .parse(JSON.parse(protocol.bytes.toString('utf8')))
    const lotId = createHash('sha256')
      .update(command.documentId)
      .digest('hex')
      .slice(0, 15)
      .split('')
      .map((digit) => String(Number.parseInt(digit, 16) % 10))
      .join('')
    const event = serializeCancellationEvent({
      accessKey: String(evidence.access_key),
      authorizationProtocol: parsedProtocol.protocolNumber,
      reason: command.reason,
      occurredAt: `${new Date().toISOString().slice(0, 19)}+00:00`,
      lotId,
    })
    const signed = signCancellationEvent(event, this.credential)
    verifyCancellationEventSignature(signed, this.credential.certificate)
    await validateCancellationEventSchema({
      xml: signed,
      schemaZip: this.schemaZip,
      expectedZipDigest: this.schemaDigest,
    })
    const artifact = await this.artifacts.put(
      {
        tenantId: command.tenantId,
        documentId: command.documentId,
        kind: 'cancellation_request',
        mediaType: 'application/xml',
        sourceSchema: `PL_010d_v1.03:${this.schemaDigest}`,
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
    return {
      commandId: queued.commandId,
      documentId: command.documentId,
      status: queued.status,
      statusUrl: `/fiscal/documents/${command.documentId}`,
      simulated: true as const,
      existing: queued.existing,
    }
  }
}
