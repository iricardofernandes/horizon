import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, randomBytes } from 'node:crypto'
import { context, propagation, trace } from '@opentelemetry/api'
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
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
  PARTY_KINDS,
  PartyAddress,
  PartyEmail,
  type PartyKind,
  PartyName,
  PartyPhone,
  PartyRoles,
  TaxId,
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

const ERASED = {
  legalName: 'Erased party',
  taxId: '00000000000',
  email: 'erased@invalid.example',
  phone: '00000000',
  address: 'Erased address',
}

async function mapParty(
  tx: Transaction,
  row: typeof schema.parties.$inferSelect,
  privacy: PartyPrivacy,
): Promise<Party> {
  if (!['active', 'inactive', 'erased'].includes(row.status))
    throw new Error('Invalid persisted party status')
  if (!PARTY_KINDS.includes(row.kind as PartyKind)) throw new Error('Invalid persisted party kind')
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
  const tradeName =
    erased || row.tradeNameCiphertext === null
      ? null
      : restored(PartyName.create(open('tradeName', row.tradeNameCiphertext), '/tradeName'))
  return Party.rehydrate(
    {
      tenantId: row.tenantId,
      kind: row.kind as PartyKind,
      legalName: restored(
        PartyName.create(erased ? ERASED.legalName : open('legalName', row.legalNameCiphertext)),
      ),
      tradeName,
      taxId: restored(TaxId.create(erased ? ERASED.taxId : open('taxId', row.taxIdCiphertext))),
      email: restored(
        PartyEmail.create(erased ? ERASED.email : open('email', row.emailCiphertext)),
      ),
      phone: restored(
        PartyPhone.create(erased ? ERASED.phone : open('phone', row.phoneCiphertext)),
      ),
      address: restored(
        PartyAddress.create(erased ? ERASED.address : open('address', row.addressCiphertext)),
      ),
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
    return {
      kind: row.kind,
      legalNameCiphertext: seal('legalName', row.legalName),
      tradeNameCiphertext: row.tradeName === null ? null : seal('tradeName', row.tradeName),
      taxIdCiphertext: seal('taxId', row.taxId),
      taxIdIndex: taxIdIndex(tenantId, row.taxId, privacy),
      emailCiphertext: seal('email', row.email),
      phoneCiphertext: seal('phone', row.phone),
      addressCiphertext: seal('address', row.address),
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
      findByTaxId: async (taxId) => {
        const [row] = await tx
          .select()
          .from(schema.parties)
          .where(eq(schema.parties.taxIdIndex, taxIdIndex(tenantId, taxId, privacy)))
          .limit(1)
          .for('no key update')
        return row ? mapParty(tx, row, privacy) : null
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
                  taxId: row.taxId,
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
