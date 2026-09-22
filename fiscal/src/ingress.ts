import { createHash, randomUUID } from 'node:crypto'
import {
  catalogItemClassificationChanged,
  companyFiscalProfileChanged,
  eventEnvelopeSchema,
  partyErased,
  partyFiscalProfileChanged,
  salesFiscalOriginRecorded,
} from '@horizon/contracts'
import postgres from 'postgres'
import { sealOrigin } from './origin-crypto'

type Sql = ReturnType<typeof postgres>
type Transaction = postgres.TransactionSql
export type IngressResult = 'applied' | 'duplicate'
export const FISCAL_EVENT_TYPES = [
  'sales.fiscal-origin.recorded',
  'parties.party.fiscal-profile-changed',
  'identity.company.fiscal-profile-changed',
  'catalog.item.classification-changed',
  'parties.party.erased',
] as const

/**
 * Durable Phase 39 ingress. This creates a blocked fiscal intent, never an authorized
 * document. No tax identifier or address crosses the broker in these events.
 */
export class FiscalIngress {
  readonly #db: Sql

  constructor(
    url: string,
    private readonly masterKey: Buffer,
  ) {
    if (masterKey.length !== 32) throw new Error('Fiscal origin key must be 32 bytes')
    this.#db = postgres(url, { max: 10, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async accept(raw: unknown): Promise<IngressResult> {
    const envelope = eventEnvelopeSchema.parse(raw)
    const sourceModule = envelope.eventType.split('.')[0]
    if (!sourceModule || !isAcceptedType(envelope.eventType) || envelope.eventVersion !== 1)
      throw new Error(`Unsupported fiscal event: ${envelope.eventType} v${envelope.eventVersion}`)

    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${envelope.tenantId}, true)`
      await tx`insert into tenants (id) values (${envelope.tenantId}) on conflict do nothing`
      const claimed = await tx`
        insert into inbox (tenant_id, source_module, event_id, event_type)
        values (${envelope.tenantId}, ${sourceModule}, ${envelope.eventId}, ${envelope.eventType})
        on conflict do nothing returning event_id`
      if (claimed.length === 0) return 'duplicate'

      switch (envelope.eventType) {
        case 'sales.fiscal-origin.recorded': {
          const payload = salesFiscalOriginRecorded.payload.parse(envelope.payload)
          await recordOrigin(tx, envelope.tenantId, payload, this.masterKey)
          break
        }
        case 'parties.party.fiscal-profile-changed': {
          const payload = partyFiscalProfileChanged.payload.parse(envelope.payload)
          await recordProfileNotice(
            tx,
            envelope.tenantId,
            'parties',
            payload.partyId,
            payload.revision,
            payload.effectiveFrom,
          )
          break
        }
        case 'identity.company.fiscal-profile-changed': {
          const payload = companyFiscalProfileChanged.payload.parse(envelope.payload)
          await recordProfileNotice(
            tx,
            envelope.tenantId,
            'identity',
            payload.tenantId,
            payload.revision,
            payload.effectiveFrom,
          )
          break
        }
        case 'catalog.item.classification-changed': {
          const payload = catalogItemClassificationChanged.payload.parse(envelope.payload)
          await recordClassification(tx, envelope.tenantId, payload)
          break
        }
        case 'parties.party.erased': {
          const payload = partyErased.payload.parse(envelope.payload)
          await tx`
            insert into profile_keys (tenant_id, source_module, subject_id, material, erased_at)
            values (${envelope.tenantId}, 'parties', ${payload.partyId}, null, now())
            on conflict (tenant_id, source_module, subject_id) do update
              set material = null, erased_at = now()`
          break
        }
      }
      return 'applied'
    })
  }
}

function isAcceptedType(type: string): boolean {
  return FISCAL_EVENT_TYPES.some((accepted) => accepted === type)
}

async function recordOrigin(
  tx: Transaction,
  tenantId: string,
  payload: ReturnType<typeof salesFiscalOriginRecorded.payload.parse>,
  masterKey: Buffer,
): Promise<void> {
  const plaintext = JSON.stringify(payload)
  const digest = createHash('sha256').update(plaintext).digest('hex')
  await tx`
    insert into fiscal_intents (
      id, tenant_id, origin_module, origin_document_type, origin_id,
      purpose, order_id, customer_id, payload_digest
    ) values (
      ${randomUUID()}, ${tenantId}, ${payload.originModule}, ${payload.originDocumentType},
      ${payload.originId}, ${payload.purpose}, ${payload.orderId}, ${payload.customerId}, ${digest}
    ) on conflict on constraint fiscal_intents_origin_key do nothing`
  const [existing] = await tx`
    select id, payload_digest from fiscal_intents where tenant_id = ${tenantId}
      and origin_module = ${payload.originModule}
      and origin_document_type = ${payload.originDocumentType}
      and origin_id = ${payload.originId} and purpose = ${payload.purpose}`
  if (existing?.payload_digest !== digest)
    throw new Error('Conflicting fiscal origin payload for an existing delivery')
  const intentId = String(existing.id)
  const ciphertext = sealOrigin(masterKey, tenantId, intentId, plaintext)
  await tx`insert into fiscal_origin_payloads
    (tenant_id, intent_id, payload_ciphertext, payload_digest)
    values (${tenantId}, ${intentId}, ${ciphertext}, ${digest})
    on conflict do nothing`
  const [stored] = await tx`select payload_digest from fiscal_origin_payloads
    where tenant_id = ${tenantId} and intent_id = ${intentId}`
  if (stored?.payload_digest !== digest) throw new Error('Conflicting encrypted fiscal origin')
}

async function recordProfileNotice(
  tx: Transaction,
  tenantId: string,
  sourceModule: 'parties' | 'identity',
  subjectId: string,
  revision: number,
  effectiveFrom: string,
): Promise<void> {
  if (sourceModule === 'identity' && subjectId !== tenantId)
    throw new Error('Issuer profile tenant mismatch')
  const inserted = await tx`
    insert into profile_requests (tenant_id, source_module, subject_id, revision, effective_from)
    values (${tenantId}, ${sourceModule}, ${subjectId}, ${revision}, ${effectiveFrom})
    on conflict on constraint profile_requests_key do nothing returning revision`
  if (inserted.length > 0) return
  const [existing] = await tx`
    select effective_from from profile_requests where tenant_id = ${tenantId}
      and source_module = ${sourceModule} and subject_id = ${subjectId}
      and revision = ${revision}`
  if (calendarDate(existing?.effective_from) !== effectiveFrom)
    throw new Error('Conflicting fiscal profile notice for an existing revision')
}

async function recordClassification(
  tx: Transaction,
  tenantId: string,
  payload: ReturnType<typeof catalogItemClassificationChanged.payload.parse>,
): Promise<void> {
  const inserted = await tx`
    insert into catalog_classifications (tenant_id, item_id, revision, effective_from, ncm)
    values (${tenantId}, ${payload.itemId}, ${payload.revision}, ${payload.effectiveFrom}, ${payload.ncm})
    on conflict on constraint catalog_classifications_key do nothing returning revision`
  if (inserted.length > 0) return
  const [existing] = await tx`
    select effective_from, ncm from catalog_classifications where tenant_id = ${tenantId}
      and item_id = ${payload.itemId} and revision = ${payload.revision}`
  if (
    calendarDate(existing?.effective_from) !== payload.effectiveFrom ||
    existing?.ncm !== payload.ncm
  )
    throw new Error('Conflicting catalog classification for an existing revision')
}

function calendarDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return typeof value === 'string' ? value.slice(0, 10) : null
}
