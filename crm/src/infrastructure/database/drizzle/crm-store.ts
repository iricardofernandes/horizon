import { createHash, randomBytes } from 'node:crypto'
import { context, propagation, trace } from '@opentelemetry/api'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { AuditRecord, AuditTrail, CrmScope } from '@/application/ports/unit-of-work'
import { canonicalJson } from '@/core/audit/canonical-json'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import { Account, type AccountStatus } from '@/domain/entities/account'
import { Contact, type ContactStatus } from '@/domain/entities/contact'
import { ListEntry } from '@/domain/entities/list-entry'
import {
  Opportunity,
  type OpportunityFact,
  type OpportunityStatus,
  type RecordedFact,
} from '@/domain/entities/opportunity'
import { Pipeline } from '@/domain/entities/pipeline'
import type { SecretBox } from '@/domain/services/secret-box'
import {
  ContactEmail,
  ContactName,
  ContactPhone,
  type DocumentType,
  JobTitle,
  LabelName,
  type LawfulBasis,
  type ListKind,
  type PartyKind,
  Probability,
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
      sourceId: row.sourceId,
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
    sourceId: snapshot.sourceId,
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

export function mapPipeline(
  row: typeof schema.pipelines.$inferSelect,
  stages: readonly (typeof schema.pipelineStages.$inferSelect)[],
): Pipeline {
  return Pipeline.rehydrate(
    {
      tenantId: row.tenantId,
      name: restored(LabelName.create(row.name)),
      stages: [...stages]
        .sort((a, b) => a.position - b.position)
        .map((stage) => ({
          id: stage.id,
          name: restored(LabelName.create(stage.name)),
          probability: restored(Probability.create(stage.probabilityBps)),
          archived: stage.archived,
        })),
      archived: row.archived,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

export function mapListEntry(row: typeof schema.listEntries.$inferSelect): ListEntry {
  return ListEntry.rehydrate(
    {
      tenantId: row.tenantId,
      kind: row.kind as ListKind,
      name: restored(LabelName.create(row.name)),
      archived: row.archived,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

export function mapOpportunity(row: typeof schema.opportunities.$inferSelect): Opportunity {
  return Opportunity.rehydrate(
    row.tenantId,
    {
      accountId: row.accountId,
      title: row.title,
      contactIds: row.contactIds,
      ownerId: row.ownerId,
      sourceId: row.sourceId,
      expectedValue: { amount: row.expectedAmount.toString(), currency: row.currency },
      expectedCloseOn: row.expectedCloseOn,
      pipelineId: row.pipelineId,
      stageId: row.stageId,
      probabilityBps: row.probabilityBps,
      status: row.status as OpportunityStatus,
      lossReasonId: row.lossReasonId,
      lossNote: row.lossNote,
      closedOn: row.closedOn,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

export function mapFact(row: typeof schema.opportunityEvents.$inferSelect): RecordedFact {
  return {
    sequence: row.sequence,
    fact: row.fact as unknown as OpportunityFact,
    actor: row.actor,
    occurredAt: row.occurredAt,
  }
}

function opportunityRow(opportunity: Opportunity) {
  const { state } = opportunity
  return {
    title: state.title,
    contactIds: [...state.contactIds],
    ownerId: state.ownerId,
    sourceId: state.sourceId,
    expectedAmount: BigInt(state.expectedValue.amount),
    currency: state.expectedValue.currency,
    expectedCloseOn: state.expectedCloseOn,
    stageId: state.stageId,
    probabilityBps: state.probabilityBps,
    status: state.status,
    lossReasonId: state.lossReasonId,
    lossNote: state.lossNote,
    closedOn: state.closedOn,
    version: state.version,
    updatedAt: state.updatedAt,
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
  /** The history first, then what it publishes: both in the command's transaction. */
  const appendHistory = async (opportunity: Opportunity) => {
    const facts = opportunity.pullRecordedFacts()
    if (facts.length)
      await tx.insert(schema.opportunityEvents).values(
        facts.map((recorded) => ({
          tenantId,
          opportunityId: opportunity.id.toString(),
          sequence: recorded.sequence,
          type: recorded.fact.type,
          fact: { ...recorded.fact } as Record<string, unknown>,
          actor: recorded.actor,
          occurredAt: recorded.occurredAt,
        })),
      )
    await flush(opportunity)
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
    pipelines: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.pipelines)
          .where(eq(schema.pipelines.id, id))
          .limit(1)
          .for('update')
        if (!row) return null
        const stages = await tx
          .select()
          .from(schema.pipelineStages)
          .where(eq(schema.pipelineStages.pipelineId, id))
        return mapPipeline(row, stages)
      },
      create: async (pipeline) => {
        assertTenant(pipeline)
        const snapshot = pipeline.toSnapshot()
        await tx.insert(schema.pipelines).values({
          id: snapshot.id,
          tenantId,
          name: snapshot.name,
          archived: snapshot.archived,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
        })
        await tx
          .insert(schema.pipelineStages)
          .values(snapshot.stages.map((stage) => ({ ...stage, tenantId, pipelineId: snapshot.id })))
      },
      save: async (pipeline) => {
        assertTenant(pipeline)
        const snapshot = pipeline.toSnapshot()
        await tx
          .update(schema.pipelines)
          .set({ name: snapshot.name, archived: snapshot.archived, updatedAt: snapshot.updatedAt })
          .where(eq(schema.pipelines.id, snapshot.id))
        // Stages are never deleted: each is inserted once and updated after that.
        for (const stage of snapshot.stages)
          await tx
            .insert(schema.pipelineStages)
            .values({ ...stage, tenantId, pipelineId: snapshot.id })
            .onConflictDoUpdate({
              target: schema.pipelineStages.id,
              set: {
                name: stage.name,
                probabilityBps: stage.probabilityBps,
                position: stage.position,
                archived: stage.archived,
              },
            })
      },
    },
    lists: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.listEntries)
          .where(eq(schema.listEntries.id, id))
          .limit(1)
        return row ? mapListEntry(row) : null
      },
      findActiveByName: async (kind, name) => {
        const [row] = await tx
          .select()
          .from(schema.listEntries)
          .where(
            and(
              eq(schema.listEntries.kind, kind),
              eq(schema.listEntries.archived, false),
              sql`lower(${schema.listEntries.name}) = lower(${name})`,
            ),
          )
          .limit(1)
        return row ? mapListEntry(row) : null
      },
      create: async (entry) => {
        assertTenant(entry)
        await tx.insert(schema.listEntries).values({ ...entry.toSnapshot(), tenantId })
      },
      save: async (entry) => {
        assertTenant(entry)
        const snapshot = entry.toSnapshot()
        await tx
          .update(schema.listEntries)
          .set({ name: snapshot.name, archived: snapshot.archived, updatedAt: snapshot.updatedAt })
          .where(eq(schema.listEntries.id, snapshot.id))
      },
    },
    opportunities: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.opportunities)
          .where(eq(schema.opportunities.id, id))
          .limit(1)
          .for('update')
        return row ? mapOpportunity(row) : null
      },
      history: async (id) => {
        const rows = await tx
          .select()
          .from(schema.opportunityEvents)
          .where(eq(schema.opportunityEvents.opportunityId, id))
          .orderBy(asc(schema.opportunityEvents.sequence))
        return rows.map(mapFact)
      },
      create: async (opportunity) => {
        assertTenant(opportunity)
        const { state } = opportunity
        await tx.insert(schema.opportunities).values({
          id: opportunity.id.toString(),
          tenantId,
          accountId: state.accountId,
          pipelineId: state.pipelineId,
          createdAt: state.createdAt,
          ...opportunityRow(opportunity),
        })
        await appendHistory(opportunity)
      },
      save: async (opportunity) => {
        assertTenant(opportunity)
        await tx
          .update(schema.opportunities)
          .set(opportunityRow(opportunity))
          .where(eq(schema.opportunities.id, opportunity.id.toString()))
        await appendHistory(opportunity)
      },
    },
    audit: auditTrail(tx, tenantId),
  }
}
