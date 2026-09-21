import type { EventOutcome, ReceivedEvent, TenantScope } from '@/application/ports/unit-of-work'
import { UnitOfWork } from '@/application/ports/unit-of-work'
import type { Page, PaginationParams } from '@/core/repositories/pagination-params'
import { AuditEntry } from '@/domain/audit/audit-entry'
import type { CatalogItem } from '@/domain/entities/catalog-item'
import type { Composition } from '@/domain/entities/composition'
import type { PriceList } from '@/domain/entities/price-list'
import type { ProductFamily } from '@/domain/entities/product-family'
import type { UnitOfMeasure } from '@/domain/entities/unit-of-measure'
import type { AuditLogRepository, AuditRecord } from '@/domain/repositories/audit-log-repository'
import {
  CatalogItemsRepository,
  CompositionsRepository,
  PriceListsRepository,
  ProductFamiliesRepository,
  UnitsRepository,
} from '@/domain/repositories/catalog-repositories'

function page<T extends { id: { toString(): string } }>(
  items: readonly T[],
  params: PaginationParams,
): Page<T> {
  const offset = params.cursor === undefined ? 0 : Number.parseInt(params.cursor, 10)
  const selected = items.slice(offset, offset + params.limit + 1)
  const hasMore = selected.length > params.limit
  const visible = selected.slice(0, params.limit)
  return {
    items: visible,
    hasMore,
    ...(hasMore ? { nextCursor: String(offset + visible.length) } : {}),
  }
}

abstract class TenantRepository<
  T extends { id: { toString(): string }; belongsTo(tenantId: string): boolean },
> {
  constructor(
    protected readonly tenantId: string,
    protected readonly records: T[],
  ) {}
  protected visible(): readonly T[] {
    return this.records.filter((record) => record.belongsTo(this.tenantId))
  }
  protected byId(id: string): T | null {
    return this.visible().find((record) => record.id.toString() === id) ?? null
  }
  protected insert(record: T): void {
    if (!record.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(record)
  }
  protected replace(record: T): void {
    if (!record.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    const index = this.records.findIndex(
      (candidate) =>
        candidate.id.toString() === record.id.toString() && candidate.belongsTo(this.tenantId),
    )
    if (index < 0) throw new Error('record not found')
    this.records[index] = record
  }
}

class InMemoryUnitsRepository extends TenantRepository<UnitOfMeasure> implements UnitsRepository {
  findById(id: string): Promise<UnitOfMeasure | null> {
    return Promise.resolve(this.byId(id))
  }
  findByCode(code: string): Promise<UnitOfMeasure | null> {
    return Promise.resolve(this.visible().find((unit) => unit.toSnapshot().code === code) ?? null)
  }
  create(unit: UnitOfMeasure): Promise<void> {
    this.insert(unit)
    return Promise.resolve()
  }
  save(unit: UnitOfMeasure): Promise<void> {
    this.replace(unit)
    return Promise.resolve()
  }
  list(params: PaginationParams): Promise<Page<UnitOfMeasure>> {
    return Promise.resolve(page(this.visible(), params))
  }
}

class InMemoryFamiliesRepository
  extends TenantRepository<ProductFamily>
  implements ProductFamiliesRepository
{
  constructor(
    tenantId: string,
    records: ProductFamily[],
    private readonly items: CatalogItem[],
  ) {
    super(tenantId, records)
  }
  findById(id: string): Promise<ProductFamily | null> {
    return Promise.resolve(this.byId(id))
  }
  findByName(name: string): Promise<ProductFamily | null> {
    return Promise.resolve(
      this.visible().find((family) => family.toSnapshot().name === name) ?? null,
    )
  }
  create(family: ProductFamily): Promise<void> {
    this.insert(family)
    return Promise.resolve()
  }
  save(family: ProductFamily): Promise<void> {
    this.replace(family)
    return Promise.resolve()
  }
  list(params: PaginationParams): Promise<Page<ProductFamily>> {
    return Promise.resolve(page(this.visible(), params))
  }
  combinationTaken(familyId: string, combination: string, exceptItemId: string): Promise<boolean> {
    return Promise.resolve(
      this.items.some((item) => {
        const variant = item.toSnapshot().variant
        return (
          item.belongsTo(this.tenantId) &&
          item.id.toString() !== exceptItemId &&
          variant?.familyId === familyId &&
          variant.combination === combination
        )
      }),
    )
  }
}

/** The graph of what is made of what, walked the way the recursive query does. */
class InMemoryCompositionsRepository
  extends TenantRepository<Composition>
  implements CompositionsRepository
{
  inForce(parentItemId: string, on: string): Promise<Composition | null> {
    const candidates = this.of(parentItemId).filter(
      (composition) => composition.toSnapshot().effectiveFrom <= on,
    )
    return Promise.resolve(candidates.at(-1) ?? null)
  }
  latest(parentItemId: string): Promise<Composition | null> {
    const held = [...this.of(parentItemId)].sort((a, b) => a.version() - b.version())
    return Promise.resolve(held.at(-1) ?? null)
  }
  create(composition: Composition): Promise<void> {
    this.insert(composition)
    return Promise.resolve()
  }
  reaches(from: string, target: string): Promise<boolean> {
    const seen = new Set<string>()
    const walk = (itemId: string, depth: number): boolean => {
      if (itemId === target) return true
      if (depth > 32 || seen.has(itemId)) return false
      seen.add(itemId)
      return this.of(itemId).some((composition) =>
        composition.lines().some((line) => walk(line.componentItemId, depth + 1)),
      )
    }
    return Promise.resolve(walk(from, 0))
  }
  private of(parentItemId: string): readonly Composition[] {
    return this.visible()
      .filter((composition) => composition.parentItemId() === parentItemId)
      .sort((a, b) => {
        const left = a.toSnapshot()
        const right = b.toSnapshot()
        return left.effectiveFrom === right.effectiveFrom
          ? left.version - right.version
          : left.effectiveFrom.localeCompare(right.effectiveFrom)
      })
  }
}

class InMemoryItemsRepository
  extends TenantRepository<CatalogItem>
  implements CatalogItemsRepository
{
  findById(id: string): Promise<CatalogItem | null> {
    return Promise.resolve(this.byId(id))
  }
  findBySku(sku: string): Promise<CatalogItem | null> {
    return Promise.resolve(this.visible().find((item) => item.toSnapshot().sku === sku) ?? null)
  }
  create(item: CatalogItem): Promise<void> {
    this.insert(item)
    return Promise.resolve()
  }
  save(item: CatalogItem): Promise<void> {
    this.replace(item)
    return Promise.resolve()
  }
  list(params: PaginationParams): Promise<Page<CatalogItem>> {
    return Promise.resolve(page(this.visible(), params))
  }
}

class InMemoryPriceListsRepository
  extends TenantRepository<PriceList>
  implements PriceListsRepository
{
  findById(id: string): Promise<PriceList | null> {
    return Promise.resolve(this.byId(id))
  }
  findByName(name: string): Promise<PriceList | null> {
    return Promise.resolve(this.visible().find((list) => list.toSnapshot().name === name) ?? null)
  }
  create(priceList: PriceList): Promise<void> {
    this.insert(priceList)
    return Promise.resolve()
  }
  save(priceList: PriceList): Promise<void> {
    this.replace(priceList)
    return Promise.resolve()
  }
  list(params: PaginationParams): Promise<Page<PriceList>> {
    return Promise.resolve(page(this.visible(), params))
  }
}

/** Chains for real, so a use-case test can assert the chain and not merely the call. */
/**
 * The chain, plus the records as they were handed over.
 *
 * A test asserting who did what wants the record, not the hashed entry: reaching into the
 * entry's snapshot from an application spec is exactly what ADR 0031 forbids.
 */
class InMemoryAuditLogRepository implements AuditLogRepository {
  constructor(
    private readonly tenantId: string,
    private readonly entries: AuditEntry[],
    private readonly written: AuditRecord[] = [],
  ) {}
  private visible(): AuditEntry[] {
    return this.entries.filter((entry) => entry.toSnapshot().tenantId === this.tenantId)
  }
  append(record: AuditRecord): Promise<AuditEntry> {
    this.written.push(record)
    const last = this.visible().at(-1)
    const entry = AuditEntry.append({
      payload: {
        tenantId: this.tenantId,
        sequence: (last?.sequenceNumber() ?? 0) + 1,
        actorType: record.actor.type,
        actorId: record.actor.id,
        subjectType: record.subjectType,
        subjectId: record.subjectId,
        action: record.action,
        occurredAt: record.occurredAt,
        requestId: record.requestId ?? null,
        traceId: record.traceId ?? null,
        sourceIp: record.sourceIp ?? null,
        before: record.before ?? null,
        after: record.after ?? null,
        redacted: [],
      },
      ...(last ? { previousHash: last.hashValue() } : {}),
    })
    this.entries.push(entry)
    return Promise.resolve(entry)
  }
  walk(fromSequence: number, limit: number): Promise<readonly AuditEntry[]> {
    return Promise.resolve(
      this.visible()
        .filter((entry) => entry.sequenceNumber() > fromSequence)
        .slice(0, limit),
    )
  }
  lastSequence(): Promise<number> {
    return Promise.resolve(this.visible().at(-1)?.sequenceNumber() ?? 0)
  }
}

export class InMemoryCatalogUnitOfWork extends UnitOfWork {
  readonly units: UnitOfMeasure[] = []
  readonly items: CatalogItem[] = []
  readonly priceLists: PriceList[] = []
  readonly families: ProductFamily[] = []
  readonly compositions: Composition[] = []
  readonly auditEntries: AuditEntry[] = []
  readonly auditRecordsWritten: AuditRecord[] = []
  readonly provisionedTenants = new Set<string>()
  readonly consumedEvents = new Set<string>()

  provisionTenant(tenantId: string): Promise<void> {
    this.provisionedTenants.add(tenantId)
    return Promise.resolve()
  }

  async processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: TenantScope) => Promise<T>,
  ): Promise<EventOutcome<T>> {
    const key = `${event.sourceModule}:${event.eventId}`
    if (this.consumedEvents.has(key)) return { processed: false }
    // Claimed only once the handler commits, mirroring a transaction that rolls the
    // claim back with the work it failed to do.
    const value = await this.inTenant(tenantId, work)
    this.consumedEvents.add(key)
    return { processed: true, value }
  }

  inTenant<T>(tenantId: string, work: (scope: TenantScope) => Promise<T>): Promise<T> {
    return work({
      tenantId,
      units: new InMemoryUnitsRepository(tenantId, this.units),
      items: new InMemoryItemsRepository(tenantId, this.items),
      families: new InMemoryFamiliesRepository(tenantId, this.families, this.items),
      compositions: new InMemoryCompositionsRepository(tenantId, this.compositions),
      priceLists: new InMemoryPriceListsRepository(tenantId, this.priceLists),
      audit: new InMemoryAuditLogRepository(tenantId, this.auditEntries, this.auditRecordsWritten),
    })
  }
}
