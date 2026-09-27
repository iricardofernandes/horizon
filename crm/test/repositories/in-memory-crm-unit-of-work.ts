import type {
  AuditRecord,
  CommandReceipt,
  CrmScope,
  CrmUnitOfWork,
  EventOutcome,
  ReceivedEvent,
} from '@/application/ports/unit-of-work'
import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { DomainEvent } from '@/core/events/domain-event'
import type { Account } from '@/domain/entities/account'
import type { Contact } from '@/domain/entities/contact'
import type { ListEntry } from '@/domain/entities/list-entry'
import type { Opportunity, RecordedFact } from '@/domain/entities/opportunity'
import type { Pipeline } from '@/domain/entities/pipeline'
import type { Owner } from '@/domain/repositories/crm-repositories'

/**
 * Tenant-scoped in-memory CRM (ADR 0014). Keys stand in for the contact data keys: an
 * erased contact loses its key, which is what the e2e suite proves against PostgreSQL.
 */
export class InMemoryCrmUnitOfWork implements CrmUnitOfWork {
  readonly accounts = new Map<string, Account>()
  readonly contacts = new Map<string, Contact>()
  readonly keys = new Set<string>()
  readonly owners = new Map<string, Owner>()
  readonly pipelines = new Map<string, Pipeline>()
  readonly lists = new Map<string, ListEntry>()
  readonly opportunities = new Map<string, Opportunity>()
  readonly history = new Map<string, RecordedFact[]>()
  readonly published: DomainEvent[] = []
  readonly audit: (AuditRecord & { tenantId: string })[] = []
  readonly consumed = new Set<string>()
  readonly receipts = new Map<string, { command: string; fingerprint: string; response: unknown }>()

  inTenant<T>(tenantId: string, work: (scope: CrmScope) => Promise<T>): Promise<T> {
    const mine = <V extends { belongsTo(tenantId: string): boolean }>(value: V | undefined) =>
      value?.belongsTo(tenantId) ? value : null
    return work({
      tenantId,
      accounts: {
        findById: async (id) => mine(this.accounts.get(id)),
        create: async (account) => void this.accounts.set(account.id.toString(), account),
        save: async (account) => void this.accounts.set(account.id.toString(), account),
      },
      contacts: {
        findById: async (id) => mine(this.contacts.get(id)),
        findLiveOf: async (accountId) =>
          [...this.contacts.values()].filter(
            (contact) =>
              contact.belongsTo(tenantId) && contact.accountId === accountId && !contact.isErased(),
          ),
        create: async (contact) => {
          this.contacts.set(contact.id.toString(), contact)
          this.keys.add(contact.id.toString())
        },
        save: async (contact) => {
          this.contacts.set(contact.id.toString(), contact)
          if (contact.isErased()) this.keys.delete(contact.id.toString())
        },
      },
      owners: {
        find: async (userId) => this.owners.get(`${tenantId}:${userId}`) ?? null,
        register: async (userId) => {
          const key = `${tenantId}:${userId}`
          if (!this.owners.has(key)) this.owners.set(key, { userId, active: true })
        },
        disable: async (userId) =>
          void this.owners.set(`${tenantId}:${userId}`, { userId, active: false }),
      },
      pipelines: {
        findById: async (id) => mine(this.pipelines.get(id)),
        create: async (pipeline) => void this.pipelines.set(pipeline.id.toString(), pipeline),
        save: async (pipeline) => void this.pipelines.set(pipeline.id.toString(), pipeline),
      },
      lists: {
        findById: async (id) => mine(this.lists.get(id)),
        findActiveByName: async (kind, name) =>
          [...this.lists.values()].find(
            (entry) =>
              entry.belongsTo(tenantId) &&
              entry.kind === kind &&
              entry.isSelectable() &&
              entry.name.value.toLowerCase() === name.toLowerCase(),
          ) ?? null,
        create: async (entry) => void this.lists.set(entry.id.toString(), entry),
        save: async (entry) => void this.lists.set(entry.id.toString(), entry),
      },
      opportunities: {
        findById: async (id) => mine(this.opportunities.get(id)),
        history: async (id) => [...(this.history.get(id) ?? [])],
        create: async (opportunity) => this.keepOpportunity(opportunity),
        save: async (opportunity) => this.keepOpportunity(opportunity),
      },
      audit: { append: async (record) => void this.audit.push({ ...record, tenantId }) },
    })
  }

  private keepOpportunity(opportunity: Opportunity): void {
    const id = opportunity.id.toString()
    this.opportunities.set(id, opportunity)
    this.history.set(id, [...(this.history.get(id) ?? []), ...opportunity.pullRecordedFacts()])
    this.published.push(...opportunity.pullDomainEvents())
  }

  async once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: CrmScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>> {
    const key = `${tenantId}:${receipt.idempotencyKey}`
    const previous = this.receipts.get(key)
    if (previous) {
      if (previous.command !== receipt.command || previous.fingerprint !== receipt.fingerprint)
        return left(
          new ConflictError('this Idempotency-Key was already used for a different request'),
        )
      return right(previous.response as T)
    }
    const outcome = await this.inTenant(tenantId, work)
    if (outcome.isRight()) this.receipts.set(key, { ...receipt, response: outcome.value })
    return outcome
  }

  async processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: CrmScope) => Promise<T>,
  ): Promise<EventOutcome<T>> {
    const key = `${event.sourceModule}:${event.eventId}`
    if (this.consumed.has(key)) return { processed: false }
    this.consumed.add(key)
    return { processed: true, value: await this.inTenant(tenantId, work) }
  }
}
