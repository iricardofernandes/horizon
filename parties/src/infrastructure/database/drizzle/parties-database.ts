import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, randomBytes } from 'node:crypto'
import { context, propagation, trace } from '@opentelemetry/api'
import { and, asc, desc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { type PartiesScope, PartiesUnitOfWork } from '@/application/ports/unit-of-work'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import { Party, type PartySnapshot, type PartyStatus } from '@/domain/entities/party'
import type { SecretBox } from '@/domain/services/secret-box'
import { FiscalProfile, type FiscalProfileData } from '@/domain/value-objects/fiscal-profile'
import {
  type LookupField,
  type LookupProbe,
  lookupEmail,
  lookupName,
  lookupPhone,
} from '@/domain/value-objects/party-lookup'
import {
  PARTY_DOCUMENT_TYPES,
  PARTY_KINDS,
  PartyAddress,
  PartyDocument,
  type PartyDocumentType,
  PartyEmail,
  type PartyKind,
  PartyName,
  PartyPhone,
  PartyRoles,
} from '@/domain/value-objects/party-values'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface PartyPrivacy {
  readonly secretBox: SecretBox
  readonly blindIndexKey: Uint8Array
}

export interface PartiesDatabaseOptions {
  readonly url: string
  readonly poolMax?: number
  readonly statementTimeoutMs?: number
  readonly privacy: PartyPrivacy
}

export interface PartyFiscalExport {
  readonly tenantId: string
  readonly partyId: string
  readonly kind: PartyKind
  readonly legalName: string
  readonly tradeName: string | null
  readonly taxId: string
  readonly revision: number
  readonly profile: Readonly<FiscalProfileData>
}

/** Owns the connection; only tenant-bound repositories leave this module (ADR 0017). */
export class PartiesDatabase extends PartiesUnitOfWork {
  readonly #client: ReturnType<typeof postgres>
  readonly #db: Database
  readonly #transactions = new AsyncLocalStorage<{ tx: Transaction; tenantId: string }>()
  readonly #privacy: PartyPrivacy

  constructor(options: PartiesDatabaseOptions) {
    super()
    if (options.privacy.blindIndexKey.byteLength < 32)
      throw new Error('Party blind index key must have at least 32 bytes')
    this.#privacy = options.privacy
    this.#client = postgres(options.url, {
      max: options.poolMax ?? 10,
      connect_timeout: 5,
      connection: { statement_timeout: options.statementTimeoutMs ?? 5000 },
    })
    this.#db = drizzle(this.#client, { schema })
  }

  async inTenant<T>(tenantId: string, work: (scope: PartiesScope) => Promise<T>): Promise<T> {
    if (this.#transactions.getStore())
      throw new Error('Nested tenant transactions are not supported')
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`)
      // A workspace's first party provisions its tenant row, inside its own RLS context.
      await tx.insert(schema.tenants).values({ id: tenantId }).onConflictDoNothing()
      return this.#transactions.run({ tx, tenantId }, () =>
        work(makeScope(tx, tenantId, this.#privacy)),
      )
    })
  }

  /** Exact encrypted revision for the restricted, asynchronous Fiscal projector. */
  async findFiscalExport(
    tenantId: string,
    partyId: string,
    revision: number,
  ): Promise<PartyFiscalExport | null> {
    return this.inTenant(tenantId, async (scope) => {
      const party = await scope.parties.findById(partyId)
      if (!party || party.isErased()) return null
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Fiscal export requires a tenant transaction')
      const [row] = await current.tx
        .select()
        .from(schema.partyFiscalProfiles)
        .where(
          and(
            eq(schema.partyFiscalProfiles.partyId, partyId),
            eq(schema.partyFiscalProfiles.revision, revision),
          ),
        )
        .limit(1)
      if (!row) return null
      const [key] = await current.tx
        .select()
        .from(schema.partyDataKeys)
        .where(eq(schema.partyDataKeys.id, partyId))
        .limit(1)
      if (!key?.material) return null
      const plaintext = this.#privacy.secretBox.open(
        `${tenantId}:${partyId}:fiscalProfile:${key.material}`,
        row.ciphertext,
      )
      if (plaintext === null) throw new Error('Fiscal profile authentication failed')
      const exported = JSON.parse(plaintext) as Omit<PartyFiscalExport, 'tenantId'>
      const profile = restored(FiscalProfile.create(exported.profile)).details
      return {
        tenantId,
        partyId,
        kind: exported.kind,
        legalName: exported.legalName,
        tradeName: exported.tradeName,
        taxId: exported.taxId,
        revision,
        profile,
      }
    })
  }

  /** Stable, tenant-scoped cursor for fiscal projection backfill; contains no personal data. */
  async listFiscalProfileRevisions(
    tenantId: string,
    limit: number,
    afterId?: string,
  ): Promise<{
    tenantId: string
    data: readonly { partyId: string; revision: number }[]
    nextCursor: string | null
  }> {
    return this.inTenant(tenantId, async () => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Fiscal profile listing requires a tenant transaction')
      const rows = await current.tx
        .select({ partyId: schema.parties.id, revision: schema.parties.fiscalProfileRevision })
        .from(schema.parties)
        .where(
          and(
            gt(schema.parties.fiscalProfileRevision, 0),
            eq(schema.parties.status, 'active'),
            afterId === undefined ? undefined : gt(schema.parties.id, afterId),
          ),
        )
        .orderBy(asc(schema.parties.id))
        .limit(limit + 1)
      const data = rows.slice(0, limit)
      return {
        tenantId,
        data,
        nextCursor: rows.length > limit ? (data.at(-1)?.partyId ?? null) : null,
      }
    })
  }

  /** Read model for the HTTP boundary: newest first, optionally narrowed to one role. */
  async listSnapshots(
    tenantId: string,
    filter: { readonly role?: string; readonly limit: number },
  ): Promise<readonly PartySnapshot[]> {
    return this.inTenant(tenantId, async () => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Party listing requires a transaction')
      const rows = await current.tx
        .select()
        .from(schema.parties)
        .where(
          filter.role === undefined
            ? undefined
            : and(sql`${filter.role} = ANY(${schema.parties.roles})`),
        )
        .orderBy(desc(schema.parties.createdAt))
        .limit(filter.limit)
      return Promise.all(
        rows.map(async (row) => (await mapParty(current.tx, row, this.#privacy)).toSnapshot()),
      )
    })
  }

  /**
   * Fills the lookup indexes of parties written before Phase 54, one page at a time. Only
   * rows without a name index are touched, so running it again changes nothing.
   */
  async backfillLookups(tenantId: string, limit: number): Promise<number> {
    return this.inTenant(tenantId, async () => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Lookup backfill requires a transaction')
      const rows = await current.tx
        .select()
        .from(schema.parties)
        .where(and(isNull(schema.parties.nameIndex), ne(schema.parties.status, 'erased')))
        .orderBy(asc(schema.parties.id))
        .limit(limit)
        .for('no key update')
      for (const row of rows) {
        const party = (await mapParty(current.tx, row, this.#privacy)).toSnapshot()
        await current.tx
          .update(schema.parties)
          .set(lookupIndexes(tenantId, party, this.#privacy))
          .where(eq(schema.parties.id, row.id))
      }
      return rows.length
    })
  }

  async findSnapshot(tenantId: string, partyId: string): Promise<PartySnapshot | null> {
    return this.inTenant(tenantId, async (scope) => {
      const party = await scope.parties.findById(partyId)
      return party ? party.toSnapshot() : null
    })
  }

  async ping(): Promise<void> {
    await this.#db.execute(sql`select 1`)
  }

  async close(): Promise<void> {
    await this.#client.end({ timeout: 5 })
  }
}

function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted party value', { cause: result.value })
  return result.value
}

function taxIdIndex(tenantId: string, taxId: string, privacy: PartyPrivacy): string {
  return createHmac('sha256', privacy.blindIndexKey).update(`${tenantId}:${taxId}`).digest('hex')
}

/** A lookup index is tagged by field, so a name can never collide with an email. */
function lookupIndex(
  tenantId: string,
  field: Exclude<LookupField, 'document'>,
  value: string | null,
  privacy: PartyPrivacy,
): string | null {
  return value === null
    ? null
    : createHmac('sha256', privacy.blindIndexKey)
        .update(`${tenantId}:lookup:${field}:${value}`)
        .digest('hex')
}

function lookupIndexes(tenantId: string, probe: LookupProbe, privacy: PartyPrivacy) {
  return {
    nameIndex: lookupIndex(tenantId, 'name', lookupName(probe.legalName), privacy),
    emailIndex: lookupIndex(tenantId, 'email', lookupEmail(probe.email), privacy),
    phoneIndex: lookupIndex(tenantId, 'phone', lookupPhone(probe.phone), privacy),
  }
}

const ERASED_NAME = 'Erased party'

/** An erased party's number can no longer be opened, so it reads as having none. */
function restoredDocument(
  type: PartyDocumentType,
  country: string | null,
  number: string | null,
): PartyDocument {
  if (type === 'none' || number === null) return PartyDocument.none()
  return restored(
    type === 'foreign'
      ? PartyDocument.create({ type, country: country ?? '', number })
      : PartyDocument.create({ type, number }),
  )
}

async function mapParty(
  tx: Transaction,
  row: typeof schema.parties.$inferSelect,
  privacy: PartyPrivacy,
): Promise<Party> {
  if (!['active', 'inactive', 'erased'].includes(row.status))
    throw new Error('Invalid persisted party status')
  if (!PARTY_KINDS.includes(row.kind as PartyKind)) throw new Error('Invalid persisted party kind')
  if (!PARTY_DOCUMENT_TYPES.includes(row.documentType as PartyDocumentType))
    throw new Error('Invalid persisted party document type')
  const erased = row.status === 'erased'
  const [key] = await tx
    .select()
    .from(schema.partyDataKeys)
    .where(eq(schema.partyDataKeys.id, row.id))
    .limit(1)
  const material = key?.material ?? null
  const open = (field: string, ciphertext: string): string => {
    if (!material) throw new Error('Party data key is unavailable')
    const plaintext = privacy.secretBox.open(
      `${row.tenantId}:${row.id}:${field}:${material}`,
      ciphertext,
    )
    if (plaintext === null) throw new Error('Party personal data authentication failed')
    return plaintext
  }
  const openOptional = (field: string, ciphertext: string | null): string | null =>
    erased || ciphertext === null ? null : open(field, ciphertext)
  const tradeName = openOptional('tradeName', row.tradeNameCiphertext)
  const email = openOptional('email', row.emailCiphertext)
  const phone = openOptional('phone', row.phoneCiphertext)
  const address = openOptional('address', row.addressCiphertext)
  const document = restoredDocument(
    row.documentType as PartyDocumentType,
    row.documentCountry,
    openOptional('taxId', row.taxIdCiphertext),
  )
  return Party.rehydrate(
    {
      tenantId: row.tenantId,
      kind: row.kind as PartyKind,
      legalName: restored(
        PartyName.create(erased ? ERASED_NAME : open('legalName', row.legalNameCiphertext)),
      ),
      tradeName: tradeName === null ? null : restored(PartyName.create(tradeName, '/tradeName')),
      document,
      email: email === null ? null : restored(PartyEmail.create(email)),
      phone: phone === null ? null : restored(PartyPhone.create(phone)),
      address: address === null ? null : restored(PartyAddress.create(address)),
      fiscalProfile:
        erased || row.fiscalProfileCiphertext === null
          ? null
          : restored(
              FiscalProfile.create(JSON.parse(open('fiscalProfile', row.fiscalProfileCiphertext))),
            ),
      fiscalProfileRevision: row.fiscalProfileRevision,
      roles: restored(PartyRoles.of(row.roles)),
      status: row.status as PartyStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

async function publish(tx: Transaction, tenantId: string, event: DomainEvent): Promise<void> {
  if (event.tenantId !== tenantId) throw new Error('Event tenant does not match transaction')
  const id = new UniqueEntityID().toString()
  const carrier: Record<string, string> = {}
  propagation.inject(context.active(), carrier)
  await tx.insert(schema.outbox).values({
    id,
    eventId: id,
    tenantId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    occurredAt: event.occurredAt,
    traceId:
      trace.getSpan(context.active())?.spanContext().traceId ?? randomBytes(16).toString('hex'),
    traceParent: carrier.traceparent ?? null,
    payload: { ...event.payloadOf() },
  })
}

function makeScope(tx: Transaction, tenantId: string, privacy: PartyPrivacy): PartiesScope {
  const assertTenant = (actual: string) => {
    if (actual !== tenantId) throw new Error('Aggregate tenant does not match transaction')
  }
  const materialFor = async (partyId: string): Promise<string> => {
    const [key] = await tx
      .select()
      .from(schema.partyDataKeys)
      .where(eq(schema.partyDataKeys.id, partyId))
      .limit(1)
    if (!key?.material) throw new Error('Party data key is unavailable')
    return key.material
  }
  const sealed = (row: PartySnapshot, material: string) => {
    const seal = (field: string, value: string) =>
      privacy.secretBox.seal(`${tenantId}:${row.id}:${field}:${material}`, value)
    const sealOptional = (field: string, value: string | null) =>
      value === null ? null : seal(field, value)
    return {
      kind: row.kind,
      documentType: row.document.type,
      documentCountry: row.document.country,
      legalNameCiphertext: seal('legalName', row.legalName),
      tradeNameCiphertext: sealOptional('tradeName', row.tradeName),
      taxIdCiphertext: sealOptional('taxId', row.document.number),
      taxIdIndex: documentIndex(row.document),
      emailCiphertext: sealOptional('email', row.email),
      phoneCiphertext: sealOptional('phone', row.phone),
      addressCiphertext: sealOptional('address', row.address),
      ...lookupIndexes(tenantId, row, privacy),
      fiscalProfileCiphertext:
        row.fiscalProfile === null
          ? null
          : seal('fiscalProfile', JSON.stringify(row.fiscalProfile)),
      fiscalProfileRevision: row.fiscalProfileRevision,
      roles: [...row.roles],
      status: row.status,
      updatedAt: row.updatedAt,
    }
  }
  const documentIndex = (document: PartySnapshot['document']): string | null => {
    const input = PartyDocument.indexInputOf(document)
    return input === null ? null : taxIdIndex(tenantId, input, privacy)
  }
  const flush = async (party: Party) => {
    for (const event of party.pullDomainEvents()) await publish(tx, tenantId, event)
  }
  return {
    tenantId,
    parties: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.parties)
          .where(eq(schema.parties.id, id))
          .limit(1)
          .for('no key update')
        return row ? mapParty(tx, row, privacy) : null
      },
      findByDocument: async (document) => {
        const input = document.indexInput
        if (input === null) return null
        const [row] = await tx
          .select()
          .from(schema.parties)
          .where(eq(schema.parties.taxIdIndex, taxIdIndex(tenantId, input, privacy)))
          .limit(1)
          .for('no key update')
        return row ? mapParty(tx, row, privacy) : null
      },
      findLookalikes: async (probe, limit) => {
        const indexes = lookupIndexes(tenantId, probe, privacy)
        const documentInput = probe.document.indexInput
        const document =
          documentInput === null ? null : taxIdIndex(tenantId, documentInput, privacy)
        const matches = [
          document === null ? undefined : eq(schema.parties.taxIdIndex, document),
          indexes.nameIndex === null ? undefined : eq(schema.parties.nameIndex, indexes.nameIndex),
          indexes.emailIndex === null
            ? undefined
            : eq(schema.parties.emailIndex, indexes.emailIndex),
          indexes.phoneIndex === null
            ? undefined
            : eq(schema.parties.phoneIndex, indexes.phoneIndex),
        ].filter((condition) => condition !== undefined)
        if (!matches.length) return []
        const rows = await tx
          .select()
          .from(schema.parties)
          .where(and(ne(schema.parties.status, 'erased'), or(...matches)))
          .orderBy(desc(schema.parties.createdAt))
          .limit(limit)
        return Promise.all(
          rows.map(async (row) => ({
            party: await mapParty(tx, row, privacy),
            matchedOn: (
              [
                ['document', document !== null && row.taxIdIndex === document],
                ['name', indexes.nameIndex !== null && row.nameIndex === indexes.nameIndex],
                ['email', indexes.emailIndex !== null && row.emailIndex === indexes.emailIndex],
                ['phone', indexes.phoneIndex !== null && row.phoneIndex === indexes.phoneIndex],
              ] as const
            )
              .filter(([, matched]) => matched)
              .map(([field]) => field),
          })),
        )
      },
      create: async (party) => {
        const row = party.toSnapshot()
        assertTenant(row.tenantId)
        const material = randomBytes(32).toString('base64url')
        await tx
          .insert(schema.partyDataKeys)
          .values({ id: row.id, tenantId, material, createdAt: row.createdAt })
        await tx
          .insert(schema.parties)
          .values({ id: row.id, tenantId, createdAt: row.createdAt, ...sealed(row, material) })
        await flush(party)
      },
      save: async (party) => {
        const row = party.toSnapshot()
        assertTenant(row.tenantId)
        if (row.status === 'erased') {
          // Crypto-shredding: the ciphertext stays, and nothing can open it any more.
          await tx
            .update(schema.parties)
            .set({
              status: 'erased',
              roles: [],
              taxIdIndex: `erased:${row.id}`,
              nameIndex: null,
              emailIndex: null,
              phoneIndex: null,
              updatedAt: row.updatedAt,
            })
            .where(eq(schema.parties.id, row.id))
          await tx
            .update(schema.partyDataKeys)
            .set({ material: null, erasedAt: row.updatedAt })
            .where(eq(schema.partyDataKeys.id, row.id))
        } else {
          const [before] = await tx
            .select({ revision: schema.parties.fiscalProfileRevision })
            .from(schema.parties)
            .where(eq(schema.parties.id, row.id))
            .limit(1)
          if (!before) throw new Error('Party disappeared during fiscal profile update')
          if (row.fiscalProfileRevision > before.revision + 1)
            throw new Error('Fiscal profile revision skipped')
          if (row.fiscalProfileRevision === before.revision + 1 && row.fiscalProfile) {
            const material = await materialFor(row.id)
            await tx.insert(schema.partyFiscalProfiles).values({
              tenantId,
              partyId: row.id,
              revision: row.fiscalProfileRevision,
              effectiveFrom: row.fiscalProfile.effectiveFrom,
              ciphertext: privacy.secretBox.seal(
                `${tenantId}:${row.id}:fiscalProfile:${material}`,
                JSON.stringify({
                  partyId: row.id,
                  kind: row.kind,
                  legalName: row.legalName,
                  tradeName: row.tradeName,
                  taxId: row.document.number,
                  revision: row.fiscalProfileRevision,
                  profile: row.fiscalProfile,
                }),
              ),
              recordedAt: row.updatedAt,
            })
          }
          await tx
            .update(schema.parties)
            .set(sealed(row, await materialFor(row.id)))
            .where(eq(schema.parties.id, row.id))
        }
        await flush(party)
      },
    },
    events: { append: (event) => publish(tx, tenantId, event) },
  }
}
