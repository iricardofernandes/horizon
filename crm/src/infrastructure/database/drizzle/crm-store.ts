import { createHash, randomBytes } from 'node:crypto'
import { context, propagation, trace } from '@opentelemetry/api'
import { and, desc, eq, ne, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { AuditRecord, AuditTrail, CrmScope } from '@/application/ports/unit-of-work'
import { canonicalJson } from '@/core/audit/canonical-json'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import { Account, type AccountStatus } from '@/domain/entities/account'
import { Contact, type ContactStatus } from '@/domain/entities/contact'
import type { SecretBox } from '@/domain/services/secret-box'
import {
  ContactEmail,
  ContactName,
  ContactPhone,
  type DocumentType,
  JobTitle,
  type LawfulBasis,
  type PartyKind,
  Segment,
  Tags,
} from '@/domain/value-objects/crm-values'
import * as schema from './schema'

export type Transaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>['transaction']>[0]
>[0]

const GENESIS_HASH = '0'.repeat(64)
/** What an erased contact reads as: its sealed fields can no longer be opened. */
const ERASED_NAME = 'Erased contact'

function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted CRM value', { cause: result.value })
  return result.value
}

export function mapAccount(row: typeof schema.accounts.$inferSelect): Account {
  return Account.rehydrate(
    {
      tenantId: row.tenantId,
      party: {
        kind: row.kind as PartyKind | null,
        legalName: row.legalName ?? '',
        tradeName: row.tradeName,
        roles: row.roles,
        documentType: row.documentType as DocumentType | null,
        documentCountry: row.documentCountry,
        active: row.partyActive,
      },
      ownerId: row.ownerId,
      segment: row.segment === null ? null : restored(Segment.create(row.segment)),
      tags: restored(Tags.of(row.tags)),
      status: row.status as AccountStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function accountRow(account: Account) {
  const snapshot = account.toSnapshot()
  return {
    kind: snapshot.kind,
    legalName: snapshot.status === 'erased' ? '' : snapshot.legalName,
    tradeName: snapshot.tradeName,
    roles: [...snapshot.roles],
    documentType: snapshot.documentType,
    documentCountry: snapshot.documentCountry,
    partyActive: snapshot.partyActive,
    ownerId: snapshot.ownerId,
    segment: snapshot.segment,
    tags: [...snapshot.tags],
    status: snapshot.status,
    updatedAt: snapshot.updatedAt,
  }
}

/** Opens and seals a contact's fields under its own key; a destroyed key opens nothing. */
export class ContactSealer {
  constructor(private readonly secretBox: SecretBox) {}

  async materialOf(tx: Transaction, contactId: string): Promise<string | null> {
    const [key] = await tx
      .select({ material: schema.contactDataKeys.material })
      .from(schema.contactDataKeys)
      .where(eq(schema.contactDataKeys.id, contactId))
      .limit(1)
    return key?.material ?? null
  }

  seal(tenantId: string, contactId: string, material: string, field: string, value: string) {
    return this.secretBox.seal(`${tenantId}:${contactId}:${field}:${material}`, value)
  }

  open(tenantId: string, contactId: string, material: string, field: string, sealed: string) {
    const plaintext = this.secretBox.open(`${tenantId}:${contactId}:${field}:${material}`, sealed)
    if (plaintext === null) throw new Error('Contact personal data authentication failed')
    return plaintext
  }

  async map(tx: Transaction, row: typeof schema.contacts.$inferSelect): Promise<Contact> {
    const erased = row.status === 'erased'
    const material = erased ? null : await this.materialOf(tx, row.id)
    if (!erased && material === null) throw new Error('Contact data key is unavailable')
    const open = (field: string, sealed: string | null): string | null =>
      sealed === null || material === null
        ? null
        : this.open(row.tenantId, row.id, material, field, sealed)
    const jobTitle = open('jobTitle', row.jobTitleCiphertext)
    const email = open('email', row.emailCiphertext)
    const phone = open('phone', row.phoneCiphertext)
    return Contact.rehydrate(
      {
        tenantId: row.tenantId,
        accountId: row.accountId,
        name: restored(ContactName.create(open('name', row.nameCiphertext) ?? ERASED_NAME)),
        jobTitle: jobTitle === null ? null : restored(JobTitle.create(jobTitle)),
        email: email === null ? null : restored(ContactEmail.create(email)),
        phone: phone === null ? null : restored(ContactPhone.create(phone)),
        lawfulBasis: row.lawfulBasis as LawfulBasis,
        status: row.status as ContactStatus,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      new UniqueEntityID(row.id),
    )
  }

  sealed(tenantId: string, contact: Contact, material: string) {
    const snapshot = contact.toSnapshot()
    const seal = (field: string, value: string | null) =>
      value === null ? null : this.seal(tenantId, snapshot.id, material, field, value)
    return {
      nameCiphertext: this.seal(tenantId, snapshot.id, material, 'name', snapshot.name ?? ''),
      jobTitleCiphertext: seal('jobTitle', snapshot.jobTitle),
      emailCiphertext: seal('email', snapshot.email),
      phoneCiphertext: seal('phone', snapshot.phone),
      lawfulBasis: snapshot.lawfulBasis,
      status: snapshot.status,
      updatedAt: snapshot.updatedAt,
    }
  }
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

/** `hash = sha256(previous_hash || canonical_json(entry))`, as identity's chain (ADR 0025). */
export function auditHash(previousHash: string, entry: Record<string, unknown>): string {
  return createHash('sha256')
    .update(previousHash, 'utf8')
    .update(canonicalJson(entry), 'utf8')
    .digest('hex')
}

function auditTrail(tx: Transaction, tenantId: string): AuditTrail {
  return {
    append: async (record: AuditRecord) => {
      // A per-tenant transaction lock serializes chain appends, including the first link.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`crm.audit:${tenantId}`}, 0))`,
      )
      const [last] = await tx
        .select({ sequence: schema.auditLog.sequence, hash: schema.auditLog.hash })
        .from(schema.auditLog)
        .orderBy(desc(schema.auditLog.sequence))
        .limit(1)
      const entry = {
        sequence: (last?.sequence ?? 0) + 1,
        tenantId,
        actor: record.actor,
        subjectType: record.subjectType,
        subjectId: record.subjectId,
        action: record.action,
        occurredAt: record.occurredAt,
        requestId: record.requestId,
        traceId: trace.getSpan(context.active())?.spanContext().traceId ?? null,
        details: JSON.parse(canonicalJson(record.details)) as Record<string, unknown>,
      }
      const previousHash = last?.hash ?? GENESIS_HASH
      await tx.insert(schema.auditLog).values({
        id: new UniqueEntityID().toString(),
        ...entry,
        previousHash,
        hash: auditHash(previousHash, entry),
      })
    },
  }
}

export function makeScope(tx: Transaction, tenantId: string, sealer: ContactSealer): CrmScope {
  const assertTenant = (owner: { belongsTo(tenantId: string): boolean }) => {
    if (!owner.belongsTo(tenantId)) throw new Error('Aggregate tenant does not match transaction')
  }
  const flush = async (aggregate: { pullDomainEvents(): readonly DomainEvent[] }) => {
    for (const event of aggregate.pullDomainEvents()) await publish(tx, tenantId, event)
  }
  return {
    tenantId,
    accounts: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.id, id))
          .limit(1)
          .for('update')
        return row ? mapAccount(row) : null
      },
      create: async (account) => {
        assertTenant(account)
        const snapshot = account.toSnapshot()
        await tx.insert(schema.accounts).values({
          id: snapshot.id,
          tenantId,
          createdAt: snapshot.createdAt,
          ...accountRow(account),
        })
        await flush(account)
      },
      save: async (account) => {
        assertTenant(account)
        await tx
          .update(schema.accounts)
          .set(accountRow(account))
          .where(eq(schema.accounts.id, account.id.toString()))
        await flush(account)
      },
    },
    contacts: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.id, id))
          .limit(1)
          .for('update')
        return row ? sealer.map(tx, row) : null
      },
      findLiveOf: async (accountId) => {
        const rows = await tx
          .select()
          .from(schema.contacts)
          .where(
            and(eq(schema.contacts.accountId, accountId), ne(schema.contacts.status, 'erased')),
          )
          .for('update')
        return Promise.all(rows.map((row) => sealer.map(tx, row)))
      },
      create: async (contact) => {
        assertTenant(contact)
        const snapshot = contact.toSnapshot()
        const material = randomBytes(32).toString('base64url')
        await tx
          .insert(schema.contactDataKeys)
          .values({ id: snapshot.id, tenantId, material, createdAt: snapshot.createdAt })
        await tx.insert(schema.contacts).values({
          id: snapshot.id,
          tenantId,
          accountId: snapshot.accountId,
          createdAt: snapshot.createdAt,
          ...sealer.sealed(tenantId, contact, material),
        })
        await flush(contact)
      },
      save: async (contact) => {
        assertTenant(contact)
        const snapshot = contact.toSnapshot()
        if (snapshot.status === 'erased') {
          // Crypto-shredding: the ciphertext stays, and nothing can open it any more.
          await tx
            .update(schema.contacts)
            .set({ status: 'erased', updatedAt: snapshot.updatedAt })
            .where(eq(schema.contacts.id, snapshot.id))
          await tx
            .update(schema.contactDataKeys)
            .set({ material: null, erasedAt: snapshot.updatedAt })
            .where(eq(schema.contactDataKeys.id, snapshot.id))
        } else {
          const material = await sealer.materialOf(tx, snapshot.id)
          if (material === null) throw new Error('Contact data key is unavailable')
          await tx
            .update(schema.contacts)
            .set(sealer.sealed(tenantId, contact, material))
            .where(eq(schema.contacts.id, snapshot.id))
        }
        await flush(contact)
      },
    },
    owners: {
      find: async (userId) => {
        const [row] = await tx
          .select({ userId: schema.owners.userId, active: schema.owners.active })
          .from(schema.owners)
          .where(eq(schema.owners.userId, userId))
          .limit(1)
        return row ?? null
      },
      register: async (userId, at) => {
        await tx
          .insert(schema.owners)
          .values({ tenantId, userId, active: true, registeredAt: at })
          .onConflictDoNothing()
      },
      disable: async (userId, at) => {
        await tx
          .insert(schema.owners)
          .values({ tenantId, userId, active: false, registeredAt: at, disabledAt: at })
          .onConflictDoUpdate({
            target: [schema.owners.tenantId, schema.owners.userId],
            set: { active: false, disabledAt: at },
            where: eq(schema.owners.active, true),
          })
      },
    },
    audit: auditTrail(tx, tenantId),
  }
}
