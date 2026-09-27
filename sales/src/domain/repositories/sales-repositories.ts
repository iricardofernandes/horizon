import type { DomainEvent } from '@/core/events/domain-event'
import type { Customer } from '../entities/customer'
import type { Quote } from '../entities/quote'
import type { SalesOrder } from '../entities/sales-order'
import type { ServiceContract } from '../entities/service-contract'
import type { ServiceOrder } from '../entities/service-order'
import type { Shipment } from '../entities/shipment'
import type { BillingRun, NfseOutcome, RunItem } from '../services/contract-billing'
import type { LineDescription, Money } from '../value-objects/sales-values'

/** What the Catalog says an item is; null for an item projected before Phase 49. */
export type ItemKind = 'product' | 'service'

export interface CatalogItemProjection {
  readonly tenantId: string
  readonly itemId: string
  readonly description: LineDescription
  readonly unitPrice: Money
  readonly active: boolean
  readonly kind: ItemKind | null
}

export abstract class SalesOrdersRepository {
  abstract findById(id: string): Promise<SalesOrder | null>
  abstract create(order: SalesOrder): Promise<void>
  abstract save(order: SalesOrder): Promise<void>
}

/** Services sold and delivered stage by stage (ADR 0056). */
export abstract class ServiceOrdersRepository {
  abstract findById(id: string): Promise<ServiceOrder | null>
  abstract create(order: ServiceOrder): Promise<void>
  abstract save(order: ServiceOrder): Promise<void>
}

/** Services sold for a recurring fee, in effective-dated revisions (Phase 51). */
export abstract class ServiceContractsRepository {
  /** Loads the contract to change it, holding it until the transaction ends. */
  abstract findById(id: string): Promise<ServiceContract | null>
  /** Loads the contract to read it, without holding it. */
  abstract read(id: string): Promise<ServiceContract | null>
  abstract create(contract: ServiceContract): Promise<void>
  abstract save(contract: ServiceContract): Promise<void>
  /** Active, self-renewing contracts ending by `horizon`: candidates the domain decides on. */
  abstract renewable(horizon: string): Promise<readonly string[]>
  /** Active contracts in force at some point of `[from, to]`: a billing run's candidates. */
  abstract inForce(from: string, to: string): Promise<readonly string[]>
}

/** Billing runs and what they did to each contract (Phase 52). */
export abstract class BillingRunsRepository {
  abstract create(run: BillingRun): Promise<void>
  abstract findById(id: string): Promise<BillingRun | null>
  /** Contracts of the run still waiting for a decision, oldest first. */
  abstract pending(runId: string, limit: number): Promise<readonly string[]>
  /** Locks one item; false when it was already decided. */
  abstract claim(runId: string, contractId: string): Promise<boolean>
  abstract decide(
    runId: string,
    contractId: string,
    decision: Pick<RunItem, 'outcome' | 'reason' | 'billedPeriodId'>,
    at: Date,
  ): Promise<void>
  /** Closes a running run when nothing is pending; true only for the call that closed it. */
  abstract complete(runId: string, at: Date): Promise<boolean>
}

/**
 * What the owners did with a billed period (Phase 52) or a service delivery (Phase 53),
 * followed from their events.
 */
export abstract class BilledEffectsRepository {
  abstract receivablePosted(billedPeriodId: string, titleId: string, at: Date): Promise<boolean>
  abstract deliveryReceivablePosted(deliveryId: string, titleId: string, at: Date): Promise<boolean>
  /** Marks the reversal on whichever billed period or delivery raised the title. */
  abstract receivableReversed(titleId: string, at: Date): Promise<boolean>
  abstract deliveryNfseObserved(
    entryId: string,
    documentId: string,
    outcome: NfseOutcome,
    at: Date,
  ): Promise<boolean>
  abstract nfseObserved(
    entryId: string,
    documentId: string,
    outcome: NfseOutcome,
    at: Date,
  ): Promise<boolean>
}

/** A projection fed by `parties/`; Sales never registers a customer itself (ADR 0040). */
export abstract class CustomersRepository {
  abstract findById(id: string): Promise<Customer | null>
  abstract create(customer: Customer): Promise<void>
  abstract save(customer: Customer): Promise<void>
  abstract erase(customer: Customer): Promise<void>
}

export abstract class ShipmentsRepository {
  abstract findById(id: string): Promise<Shipment | null>
  abstract create(shipment: Shipment): Promise<void>
  abstract save(shipment: Shipment): Promise<void>
}

export abstract class QuotesRepository {
  abstract findById(id: string): Promise<Quote | null>
  abstract create(quote: Quote): Promise<void>
  abstract save(quote: Quote): Promise<void>
}

export abstract class CatalogItemsRepository {
  abstract findById(id: string): Promise<CatalogItemProjection | null>
  abstract recordItem(item: {
    tenantId: string
    itemId: string
    description: LineDescription
    kind: ItemKind
  }): Promise<void>
  /** Kinds of the given items, whether or not they are priced; absent when unknown. */
  abstract kindsOf(itemIds: readonly string[]): Promise<ReadonlyMap<string, ItemKind>>
  /** Fills a kind that was never recorded; a recorded kind is never changed. */
  abstract backfillKind(itemId: string, kind: ItemKind): Promise<boolean>
  abstract unknownKinds(limit: number): Promise<readonly string[]>
  abstract recordPrice(itemId: string, unitPrice: Money): Promise<void>
  abstract deactivate(itemId: string): Promise<void>
}

/** Persists domain events to the outbox owned by the surrounding transaction. */
export abstract class SalesEventsRepository {
  abstract append(event: DomainEvent): Promise<void>
}
