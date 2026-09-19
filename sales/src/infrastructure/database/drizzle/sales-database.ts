import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { context, propagation, trace } from '@opentelemetry/api'
import { desc, eq, sql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type {
  AuditRecord,
  AuditTrail,
  CommandReceipt,
  EventOutcome,
  ReceivedEvent,
  SalesScope,
} from '@/application/ports/unit-of-work'
import { SalesUnitOfWork } from '@/application/ports/unit-of-work'
import { canonicalJson } from '@/core/audit/canonical-json'
import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { DomainEvent } from '@/core/events/domain-event'
import { Customer } from '@/domain/entities/customer'
import {
  APPROVAL_STATES,
  type ApprovalState,
  QUOTE_STATUSES,
  Quote,
  type QuoteStatus,
} from '@/domain/entities/quote'
import { SalesOrder } from '@/domain/entities/sales-order'
import { SHIPMENT_STATUSES, Shipment, type ShipmentStatus } from '@/domain/entities/shipment'
import type { SecretBox } from '@/domain/services/secret-box'
import {
  BusinessDate,
  CarrierName,
  Currency,
  CustomerEmail,
  CustomerName,
  CustomerPhone,
  LineDescription,
  Money,
  PaymentTerms,
  Quantity,
  Reason,
  TaxId,
  TrackingCode,
} from '@/domain/value-objects/sales-values'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface SalesDatabaseOptions {
  readonly url: string
  readonly poolMax?: number
  readonly statementTimeoutMs?: number
  readonly customerPrivacy?: {
    readonly secretBox: SecretBox
    readonly blindIndexKey: Uint8Array
  }
}

/** Carries a refused command out of its transaction, so nothing it wrote is kept. */
class Refused<E> extends Error {
  constructor(readonly failure: E) {
    super('command refused')
  }
}

/** The first link of a tenant's audit chain has no predecessor to hash (ADR 0025). */
const GENESIS_HASH = '0'.repeat(64)

export class SalesDatabase extends SalesUnitOfWork {
  readonly #client: ReturnType<typeof postgres>
  readonly #db: Database
  readonly #transactions = new AsyncLocalStorage<{ tx: Transaction; tenantId: string }>()
  readonly #customerPrivacy: SalesDatabaseOptions['customerPrivacy']

  constructor(options: SalesDatabaseOptions) {
    super()
    if (options.customerPrivacy && options.customerPrivacy.blindIndexKey.byteLength < 32)
      throw new Error('Customer blind index key must have at least 32 bytes')
    this.#customerPrivacy = options.customerPrivacy
    this.#client = postgres(options.url, {
      max: options.poolMax ?? 10,
      connect_timeout: 5,
      connection: { statement_timeout: options.statementTimeoutMs ?? 5000 },
    })
    this.#db = drizzle(this.#client, { schema })
  }

  async provisionTenant(tenantId: string): Promise<void> {
    await this.inTenant(tenantId, async () => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Tenant provisioning requires a transaction')
      await current.tx.insert(schema.tenants).values({ id: tenantId }).onConflictDoNothing()
    })
  }

  async inTenant<T>(tenantId: string, work: (scope: SalesScope) => Promise<T>): Promise<T> {
    if (this.#transactions.getStore())
      throw new Error('Nested tenant transactions are not supported')
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`)
      return this.#transactions.run({ tx, tenantId }, () =>
        work(makeScope(tx, tenantId, this.#customerPrivacy)),
      )
    })
  }

  async once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: SalesScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>> {
    try {
      return await this.inTenant(tenantId, async (scope) => {
        const tx = this.currentTransaction()
        // Claiming first makes a concurrent retry wait on this transaction, then see its
        // receipt rather than write a second document.
        const claimed = await tx
          .insert(schema.commandReceipts)
          .values({ tenantId, ...receipt, response: {} })
          .onConflictDoNothing()
          .returning({ key: schema.commandReceipts.idempotencyKey })
        if (claimed.length === 0) {
          const [previous] = await tx
            .select()
            .from(schema.commandReceipts)
            .where(eq(schema.commandReceipts.idempotencyKey, receipt.idempotencyKey))
          if (previous?.command !== receipt.command || previous.fingerprint !== receipt.fingerprint)
            return left<E | ConflictError, T>(
              new ConflictError('this Idempotency-Key was already used for a different request'),
            )
          return right<E | ConflictError, T>(previous.response as T)
        }
        const outcome = await work(scope)
        if (outcome.isLeft()) throw new Refused(outcome.value)
        await tx
          .update(schema.commandReceipts)
          .set({ response: outcome.value as object })
          .where(eq(schema.commandReceipts.idempotencyKey, receipt.idempotencyKey))
        return right<E | ConflictError, T>(outcome.value)
      })
    } catch (error) {
      if (error instanceof Refused) return left(error.failure as E)
      throw error
    }
  }

  async processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: SalesScope) => Promise<T>,
  ): Promise<EventOutcome<T>> {
    return this.inTenant(tenantId, async (scope) => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Inbox processing requires a transaction')
      const claimed = await current.tx
        .insert(schema.inbox)
        .values({ ...event, tenantId })
        .onConflictDoNothing({ target: [schema.inbox.sourceModule, schema.inbox.eventId] })
        .returning({ eventId: schema.inbox.eventId })
      if (claimed.length === 0) return { processed: false as const }
      return { processed: true as const, value: await work(scope) }
    })
  }

  async ping(): Promise<void> {
    await this.#db.execute(sql`select 1`)
  }

  async listCustomerSnapshots(tenantId: string) {
    return this.inTenant(tenantId, async () => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Customer listing requires a transaction')
      const rows = await current.tx
        .select()
        .from(schema.customers)
        .orderBy(sql`${schema.customers.createdAt} asc`)
        .limit(100)
      return Promise.all(
        rows.map(async (row) =>
          (await mapCustomer(current.tx, row, privacyOf(this.#customerPrivacy))).toSnapshot(),
        ),
      )
    })
  }

  async listOrderSnapshots(tenantId: string) {
    return this.inTenant(tenantId, async () => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Order listing requires a transaction')
      const rows = await current.tx
        .select()
        .from(schema.salesOrders)
        .orderBy(sql`${schema.salesOrders.createdAt} desc`)
        .limit(100)
      return Promise.all(
        rows.map(async (row) => {
          const lines = await current.tx
            .select()
            .from(schema.salesOrderLines)
            .where(eq(schema.salesOrderLines.orderId, row.id))
          return mapOrder(row, lines).toSnapshot()
        }),
      )
    })
  }

  async listQuoteSnapshots(tenantId: string) {
    return this.inTenant(tenantId, async () => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Quote listing requires a transaction')
      const rows = await current.tx
        .select()
        .from(schema.quotes)
        .orderBy(sql`${schema.quotes.createdAt} desc`)
        .limit(100)
      return Promise.all(
        rows.map(async (row) => {
          const lines = await current.tx
            .select()
            .from(schema.quoteLines)
            .where(eq(schema.quoteLines.quoteId, row.id))
          return mapQuote(row, lines).toSnapshot()
        }),
      )
    })
  }

  async findQuoteSnapshot(tenantId: string, quoteId: string) {
    return this.inTenant(tenantId, async () => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Quote lookup requires a transaction')
      const [row] = await current.tx
        .select()
        .from(schema.quotes)
        .where(eq(schema.quotes.id, quoteId))
        .limit(1)
      if (!row) return null
      const lines = await current.tx
        .select()
        .from(schema.quoteLines)
        .where(eq(schema.quoteLines.quoteId, row.id))
      return mapQuote(row, lines).toSnapshot()
    })
  }

  async listShipmentSnapshots(tenantId: string, orderId: string) {
    return this.inTenant(tenantId, async () => {
      const tx = this.currentTransaction()
      const rows = await tx
        .select()
        .from(schema.shipments)
        .where(eq(schema.shipments.orderId, orderId))
        .orderBy(sql`${schema.shipments.createdAt} asc`)
        .limit(100)
      return Promise.all(
        rows.map(async (row) => {
          const lines = await tx
            .select()
            .from(schema.shipmentLines)
            .where(eq(schema.shipmentLines.shipmentId, row.id))
          return mapShipment(row, lines).toSnapshot()
        }),
      )
    })
  }

  async findShipmentSnapshot(tenantId: string, shipmentId: string) {
    return this.inTenant(tenantId, async () => {
      const tx = this.currentTransaction()
      const [row] = await tx
        .select()
        .from(schema.shipments)
        .where(eq(schema.shipments.id, shipmentId))
        .limit(1)
      if (!row) return null
      const lines = await tx
        .select()
        .from(schema.shipmentLines)
        .where(eq(schema.shipmentLines.shipmentId, row.id))
      return mapShipment(row, lines).toSnapshot()
    })
  }

  async findOrderSnapshot(tenantId: string, orderId: string) {
    return this.inTenant(tenantId, async () => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Order lookup requires a transaction')
      const [row] = await current.tx
        .select()
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.id, orderId))
        .limit(1)
      if (!row) return null
      const lines = await current.tx
        .select()
        .from(schema.salesOrderLines)
        .where(eq(schema.salesOrderLines.orderId, row.id))
      return mapOrder(row, lines).toSnapshot()
    })
  }

  async close(): Promise<void> {
    await this.#client.end({ timeout: 5 })
  }

  private currentTransaction(): Transaction {
    const current = this.#transactions.getStore()
    if (!current) throw new Error('This operation requires a tenant transaction')
    return current.tx
  }
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
        sql`select pg_advisory_xact_lock(hashtextextended(${`sales.audit:${tenantId}`}, 0))`,
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

function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted sales value', { cause: result.value })
  return result.value
}

function mapOrder(
  row: typeof schema.salesOrders.$inferSelect,
  lines: readonly (typeof schema.salesOrderLines.$inferSelect)[],
): SalesOrder {
  if (
    row.status !== 'draft' &&
    row.status !== 'placed' &&
    row.status !== 'confirmed' &&
    row.status !== 'rejected' &&
    row.status !== 'cancelled'
  )
    throw new Error('Invalid persisted sales order status')
  const requestedLines = lines.map((line) => ({
    lineId: line.lineId,
    itemId: line.itemId,
    quantity: Quantity.fromMicros(line.quantity),
  }))
  const quantitiesOf = (column: 'shipped' | 'allocated') =>
    lines
      .filter((line) => line[column] > 0n)
      .map((line) => ({ lineId: line.lineId, quantity: Quantity.fromMicros(line[column]) }))
  const pricedLines = lines.flatMap((line) => {
    if (
      line.description === null ||
      line.unitPrice === null ||
      line.lineTotal === null ||
      line.currency === null
    )
      return []
    const currency = restored(Currency.create(line.currency))
    return [
      {
        lineId: line.lineId,
        itemId: line.itemId,
        quantity: Quantity.fromMicros(line.quantity),
        description: restored(LineDescription.create(line.description)),
        unitPrice: Money.fromAmount(line.unitPrice, currency),
        lineTotal: Money.fromAmount(line.lineTotal, currency),
      },
    ]
  })
  // The same three columns hold two different facts: what the customer was quoted before
  // the order is confirmed, and the snapshot the confirmation froze afterwards.
  const confirmedLines = row.status === 'confirmed' ? pricedLines : []
  const agreedLines =
    row.status === 'confirmed'
      ? []
      : pricedLines.map((line) => ({
          lineId: line.lineId,
          itemId: line.itemId,
          description: line.description,
          unitPrice: line.unitPrice,
        }))
  const currency = row.currency === null ? null : restored(Currency.create(row.currency))
  // The terms are held in the order's own currency once it has one, and in the currency of
  // the money they carry before that: an order without lines priced yet still has freight.
  const termsCurrency = currency ?? restored(Currency.create('XXX'))
  return SalesOrder.rehydrate(
    {
      tenantId: row.tenantId,
      customerId: row.customerId,
      fulfillmentWarehouseId: row.fulfillmentWarehouseId,
      quoteId: row.quoteId,
      requestedLines,
      agreedLines,
      confirmedLines,
      reservationId: row.reservationId,
      allocated: quantitiesOf('allocated'),
      shipped: quantitiesOf('shipped'),
      shipments: row.shipments,
      confirmedAt: row.confirmedAt,
      currency,
      terms: {
        sellerId: row.sellerId,
        discount: Money.fromAmount(row.discount, termsCurrency),
        freight: Money.fromAmount(row.freight, termsCurrency),
        carrier: row.carrier ? restored(CarrierName.create(row.carrier)) : null,
        paymentTerms: restored(PaymentTerms.create(row.paymentTermDays)),
        notes: row.notes,
      },
      issuedOn: restored(BusinessDate.create(row.issuedOn)),
      total: row.total === null || currency === null ? null : Money.fromAmount(row.total, currency),
      status: row.status,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

type CustomerPrivacy = NonNullable<SalesDatabaseOptions['customerPrivacy']>

function privacyOf(value: SalesDatabaseOptions['customerPrivacy']): CustomerPrivacy {
  if (!value) throw new Error('Customer privacy configuration is required')
  return value
}

function customerIndex(tenantId: string, taxId: string, privacy: CustomerPrivacy): string {
  return createHmac('sha256', privacy.blindIndexKey).update(`${tenantId}:${taxId}`).digest('hex')
}

async function mapCustomer(
  tx: Transaction,
  row: typeof schema.customers.$inferSelect,
  privacy: CustomerPrivacy,
): Promise<Customer> {
  if (row.status !== 'active' && row.status !== 'inactive' && row.status !== 'erased')
    throw new Error('Invalid persisted customer status')
  const [key] = await tx
    .select()
    .from(schema.customerDataKeys)
    .where(eq(schema.customerDataKeys.id, row.id))
    .limit(1)
  const material = key?.material ?? null
  const open = (field: string, ciphertext: string): string => {
    if (!material) throw new Error('Customer data key is unavailable')
    const plaintext = privacy.secretBox.open(
      `${row.tenantId}:${row.id}:${field}:${material}`,
      ciphertext,
    )
    if (plaintext === null) throw new Error('Customer personal data authentication failed')
    return plaintext
  }
  const erased = row.status === 'erased'
  return Customer.rehydrate(
    {
      tenantId: row.tenantId,
      name: restored(
        CustomerName.create(erased ? 'Erased customer' : open('name', row.nameCiphertext)),
      ),
      taxId:
        erased || row.taxIdCiphertext === null
          ? null
          : restored(TaxId.create(open('taxId', row.taxIdCiphertext))),
      email: restored(
        CustomerEmail.create(
          erased ? 'erased@invalid.example' : open('email', row.emailCiphertext),
        ),
      ),
      phone: restored(
        CustomerPhone.create(erased ? '00000000' : open('phone', row.phoneCiphertext)),
      ),
      address: erased ? 'Erased address' : open('address', row.addressCiphertext),
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function oneOf<T extends string>(allowed: readonly T[], value: string, what: string): T {
  if (!allowed.includes(value as T)) throw new Error(`Invalid persisted ${what}`)
  return value as T
}

function mapQuote(
  row: typeof schema.quotes.$inferSelect,
  lines: readonly (typeof schema.quoteLines.$inferSelect)[],
): Quote {
  const currency = restored(Currency.create(row.currency))
  return Quote.rehydrate(
    {
      tenantId: row.tenantId,
      rootId: row.rootId,
      version: row.version,
      customerId: row.customerId,
      currency,
      status: oneOf<QuoteStatus>(QUOTE_STATUSES, row.status, 'quote status'),
      terms: {
        sellerId: row.sellerId,
        discount: Money.fromAmount(row.discount, currency),
        freight: Money.fromAmount(row.freight, currency),
        carrier: row.carrier ? restored(CarrierName.create(row.carrier)) : null,
        paymentTerms: restored(PaymentTerms.create(row.paymentTermDays)),
        notes: row.notes,
      },
      approval: {
        state: oneOf<ApprovalState>(APPROVAL_STATES, row.approvalState, 'approval state'),
        requestedBy: row.approvalRequestedBy,
        requestedAt: row.approvalRequestedAt,
        decidedBy: row.approvalDecidedBy,
        decidedAt: row.approvalDecidedAt,
        reason: row.approvalReason ? restored(Reason.create(row.approvalReason)) : null,
      },
      expiresAt: row.expiresAt,
      supersedes: row.supersedes,
      supersededBy: row.supersededBy,
      closure: row.closureReason ? restored(Reason.create(row.closureReason)) : null,
      orderId: row.orderId,
      sentAt: row.sentAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lines: lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        quantity: Quantity.fromMicros(line.quantity),
        description: restored(LineDescription.create(line.description)),
        unitPrice: Money.fromAmount(line.unitPrice, currency),
        lineTotal: Money.fromAmount(line.lineTotal, currency),
      })),
    },
    new UniqueEntityID(row.id),
  )
}

async function publishAll(
  tx: Transaction,
  tenantId: string,
  aggregate: { pullDomainEvents(): readonly DomainEvent[] },
): Promise<void> {
  for (const event of aggregate.pullDomainEvents()) await publish(tx, tenantId, event)
}

function writeQuoteLines(tx: Transaction, tenantId: string, row: ReturnType<Quote['toSnapshot']>) {
  return tx.insert(schema.quoteLines).values(
    row.lines.map((line) => ({
      tenantId,
      quoteId: row.id,
      lineId: line.lineId,
      itemId: line.itemId,
      quantity: restored(Quantity.create(line.quantity)).micros,
      description: line.description,
      unitPrice: BigInt(line.unitPrice),
      lineTotal: BigInt(line.lineTotal),
    })),
  )
}

function shipmentRow(row: ReturnType<Shipment['toSnapshot']>) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    orderId: row.orderId,
    warehouseId: row.warehouseId,
    status: row.status,
    value: BigInt(row.value.amount),
    currency: row.value.currency,
    carrier: row.carrier,
    trackingCode: row.trackingCode,
    pickedBy: row.pickedBy,
    packedBy: row.packedBy,
    dispatchedBy: row.dispatchedBy,
    dispatchedOn: row.dispatchedOn,
    returnedBy: row.returnedBy,
    returnedOn: row.returnedOn,
    closureReason: row.closureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function mapShipment(
  row: typeof schema.shipments.$inferSelect,
  lines: readonly (typeof schema.shipmentLines.$inferSelect)[],
): Shipment {
  if (!SHIPMENT_STATUSES.includes(row.status as ShipmentStatus))
    throw new Error('Invalid persisted shipment status')
  const currency = restored(Currency.create(row.currency))
  return Shipment.rehydrate(
    {
      tenantId: row.tenantId,
      orderId: row.orderId,
      warehouseId: row.warehouseId,
      status: row.status as ShipmentStatus,
      value: Money.fromAmount(row.value, currency),
      carrier: row.carrier ? restored(CarrierName.create(row.carrier)) : null,
      trackingCode: row.trackingCode ? restored(TrackingCode.create(row.trackingCode)) : null,
      pickedBy: row.pickedBy,
      packedBy: row.packedBy,
      dispatchedBy: row.dispatchedBy,
      dispatchedOn: row.dispatchedOn ? restored(BusinessDate.create(row.dispatchedOn)) : null,
      returnedBy: row.returnedBy,
      returnedOn: row.returnedOn ? restored(BusinessDate.create(row.returnedOn)) : null,
      closure: row.closureReason ? restored(Reason.create(row.closureReason)) : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lines: lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        quantity: Quantity.fromMicros(line.quantity),
        description: restored(LineDescription.create(line.description)),
        unitPrice: Money.fromAmount(line.unitPrice, restored(Currency.create(line.currency))),
        lineTotal: Money.fromAmount(line.lineTotal, restored(Currency.create(line.currency))),
      })),
    },
    new UniqueEntityID(row.id),
  )
}

/** Every column of a quote the store writes, derived from its snapshot. */
function quoteRow(row: ReturnType<Quote['toSnapshot']>) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    rootId: row.rootId,
    version: row.version,
    customerId: row.customerId,
    status: row.status,
    net: BigInt(row.net),
    total: BigInt(row.total),
    currency: row.currency,
    sellerId: row.sellerId,
    discount: BigInt(row.discount),
    freight: BigInt(row.freight),
    carrier: row.carrier,
    paymentTermDays: [...row.paymentTermDays],
    notes: row.notes,
    approvalState: row.approvalState,
    approvalRequestedBy: row.approvalRequestedBy,
    approvalRequestedAt: row.approvalRequestedAt,
    approvalDecidedBy: row.approvalDecidedBy,
    approvalDecidedAt: row.approvalDecidedAt,
    approvalReason: row.approvalReason,
    supersedes: row.supersedes,
    supersededBy: row.supersededBy,
    closureReason: row.closureReason,
    orderId: row.orderId,
    sentAt: row.sentAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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

function makeScope(
  tx: Transaction,
  tenantId: string,
  customerPrivacy: SalesDatabaseOptions['customerPrivacy'],
): SalesScope {
  const assertTenant = (actual: string) => {
    if (actual !== tenantId) throw new Error('Aggregate tenant does not match transaction')
  }
  return {
    tenantId,
    audit: auditTrail(tx, tenantId),
    customers: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.customers)
          .where(eq(schema.customers.id, id))
          .limit(1)
          .for('no key update')
        return row ? mapCustomer(tx, row, privacyOf(customerPrivacy)) : null
      },
      create: async (customer) => {
        const privacy = privacyOf(customerPrivacy)
        const row = customer.toSnapshot()
        assertTenant(row.tenantId)
        const material = randomBytes(32).toString('base64url')
        const seal = (field: string, value: string) =>
          privacy.secretBox.seal(`${tenantId}:${row.id}:${field}:${material}`, value)
        await tx.insert(schema.customerDataKeys).values({
          id: row.id,
          tenantId,
          material,
          createdAt: row.createdAt,
        })
        await tx.insert(schema.customers).values({
          id: row.id,
          tenantId,
          nameCiphertext: seal('name', row.name),
          // Projected customers carry no tax identifier: the registry owns it (ADR 0040).
          taxIdCiphertext: row.taxId === null ? null : seal('taxId', row.taxId),
          taxIdIndex: row.taxId === null ? null : customerIndex(tenantId, row.taxId, privacy),
          emailCiphertext: seal('email', row.email),
          phoneCiphertext: seal('phone', row.phone),
          addressCiphertext: seal('address', row.address),
          status: row.status,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
      },
      save: async (customer) => {
        const privacy = privacyOf(customerPrivacy)
        const row = customer.toSnapshot()
        assertTenant(row.tenantId)
        const [key] = await tx
          .select()
          .from(schema.customerDataKeys)
          .where(eq(schema.customerDataKeys.id, row.id))
          .limit(1)
        if (!key?.material) throw new Error('Customer data key is unavailable')
        const material = key.material
        const seal = (field: string, value: string) =>
          privacy.secretBox.seal(`${tenantId}:${row.id}:${field}:${material}`, value)
        await tx
          .update(schema.customers)
          .set({
            nameCiphertext: seal('name', row.name),
            emailCiphertext: seal('email', row.email),
            phoneCiphertext: seal('phone', row.phone),
            addressCiphertext: seal('address', row.address),
            status: row.status,
            updatedAt: row.updatedAt,
          })
          .where(eq(schema.customers.id, row.id))
      },
      erase: async (customer) => {
        const row = customer.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.customers)
          .set({ status: 'erased', taxIdIndex: `erased:${row.id}`, updatedAt: row.updatedAt })
          .where(eq(schema.customers.id, row.id))
        await tx
          .update(schema.customerDataKeys)
          .set({ material: null, erasedAt: row.updatedAt })
          .where(eq(schema.customerDataKeys.id, row.id))
      },
    },
    quotes: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.quotes)
          .where(eq(schema.quotes.id, id))
          .limit(1)
          .for('update')
        if (!row) return null
        const lines = await tx
          .select()
          .from(schema.quoteLines)
          .where(eq(schema.quoteLines.quoteId, row.id))
        return mapQuote(row, lines)
      },
      create: async (quote) => {
        const row = quote.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.quotes).values(quoteRow(row))
        await writeQuoteLines(tx, tenantId, row)
        await publishAll(tx, tenantId, quote)
      },
      save: async (quote) => {
        const row = quote.toSnapshot()
        assertTenant(row.tenantId)
        // A draft is still being written; everything else is a record of what was offered.
        if (row.status === 'draft' || row.status === 'pending') {
          await tx.delete(schema.quoteLines).where(eq(schema.quoteLines.quoteId, row.id))
          await writeQuoteLines(tx, tenantId, row)
        }
        await tx
          .update(schema.quotes)
          .set({
            status: row.status,
            net: BigInt(row.net),
            total: BigInt(row.total),
            sellerId: row.sellerId,
            discount: BigInt(row.discount),
            freight: BigInt(row.freight),
            carrier: row.carrier,
            paymentTermDays: [...row.paymentTermDays],
            notes: row.notes,
            approvalState: row.approvalState,
            approvalRequestedBy: row.approvalRequestedBy,
            approvalRequestedAt: row.approvalRequestedAt,
            approvalDecidedBy: row.approvalDecidedBy,
            approvalDecidedAt: row.approvalDecidedAt,
            approvalReason: row.approvalReason,
            supersededBy: row.supersededBy,
            closureReason: row.closureReason,
            orderId: row.orderId,
            sentAt: row.sentAt,
            expiresAt: row.expiresAt,
            updatedAt: row.updatedAt,
          })
          .where(eq(schema.quotes.id, row.id))
        await publishAll(tx, tenantId, quote)
      },
    },
    orders: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.salesOrders)
          .where(eq(schema.salesOrders.id, id))
          .limit(1)
          .for('update')
        if (!row) return null
        const lines = await tx
          .select()
          .from(schema.salesOrderLines)
          .where(eq(schema.salesOrderLines.orderId, row.id))
        return mapOrder(row, lines)
      },
      create: async (order) => {
        const row = order.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.salesOrders).values({
          id: row.id,
          tenantId,
          customerId: row.customerId,
          fulfillmentWarehouseId: row.fulfillmentWarehouseId,
          quoteId: row.quoteId,
          sellerId: row.sellerId,
          discount: BigInt(row.discount),
          freight: BigInt(row.freight),
          carrier: row.carrier,
          paymentTermDays: [...row.paymentTermDays],
          issuedOn: row.issuedOn,
          notes: row.notes,
          status: row.status,
          fulfillment: row.fulfillment,
          shipments: row.shipments,
          confirmedAt: row.confirmedAt,
          version: row.version,
          reservationId: row.reservationId,
          total: row.total ? BigInt(row.total.amount) : null,
          currency: row.currency,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
        await tx.insert(schema.salesOrderLines).values(
          row.requestedLines.map((line) => ({
            tenantId,
            orderId: row.id,
            lineId: line.lineId,
            itemId: line.itemId,
            quantity: restored(Quantity.create(line.quantity)).micros,
            shipped: restored(Quantity.create(line.shipped)).micros,
            allocated: restored(Quantity.create(line.allocated)).micros,
            // Present only on an order converted from a quote: what the customer agreed to.
            description: line.description ?? null,
            unitPrice: line.unitPrice ? BigInt(line.unitPrice.amount) : null,
            lineTotal: line.lineTotal ? BigInt(line.lineTotal.amount) : null,
            currency: line.unitPrice?.currency ?? null,
          })),
        )
      },
      save: async (order) => {
        const row = order.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.salesOrders)
          .set({
            status: row.status,
            fulfillment: row.fulfillment,
            shipments: row.shipments,
            confirmedAt: row.confirmedAt,
            version: row.version,
            reservationId: row.reservationId,
            sellerId: row.sellerId,
            discount: BigInt(row.discount),
            freight: BigInt(row.freight),
            carrier: row.carrier,
            paymentTermDays: [...row.paymentTermDays],
            issuedOn: row.issuedOn,
            notes: row.notes,
            total: row.total ? BigInt(row.total.amount) : null,
            currency: row.currency,
            updatedAt: row.updatedAt,
          })
          .where(eq(schema.salesOrders.id, row.id))
        for (const line of row.confirmedLines)
          await tx
            .update(schema.salesOrderLines)
            .set({
              description: line.description,
              unitPrice: BigInt(line.unitPrice.amount),
              lineTotal: BigInt(line.lineTotal.amount),
              currency: line.unitPrice.currency,
            })
            .where(
              sql`${schema.salesOrderLines.orderId} = ${row.id} AND ${schema.salesOrderLines.lineId} = ${line.lineId}`,
            )
        for (const line of row.requestedLines)
          await tx
            .update(schema.salesOrderLines)
            .set({
              shipped: restored(Quantity.create(line.shipped)).micros,
              allocated: restored(Quantity.create(line.allocated)).micros,
            })
            .where(
              sql`${schema.salesOrderLines.orderId} = ${row.id} AND ${schema.salesOrderLines.lineId} = ${line.lineId}`,
            )
      },
    },
    shipments: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.shipments)
          .where(eq(schema.shipments.id, id))
          .limit(1)
          .for('update')
        if (!row) return null
        const lines = await tx
          .select()
          .from(schema.shipmentLines)
          .where(eq(schema.shipmentLines.shipmentId, row.id))
        return mapShipment(row, lines)
      },
      create: async (shipment) => {
        const row = shipment.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.shipments).values(shipmentRow(row))
        await tx.insert(schema.shipmentLines).values(
          row.lines.map((line) => ({
            tenantId,
            shipmentId: row.id,
            lineId: line.lineId,
            itemId: line.itemId,
            quantity: restored(Quantity.create(line.quantity)).micros,
            description: line.description,
            unitPrice: BigInt(line.unitPrice.amount),
            lineTotal: BigInt(line.lineTotal.amount),
            currency: line.unitPrice.currency,
          })),
        )
      },
      save: async (shipment) => {
        const row = shipment.toSnapshot()
        assertTenant(row.tenantId)
        // The lines are never rewritten: what is in the box is settled when it is picked,
        // and a trigger refuses to change them once it has left.
        await tx
          .update(schema.shipments)
          .set(shipmentRow(row))
          .where(eq(schema.shipments.id, row.id))
      },
    },
    catalogItems: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.catalogItems)
          .where(eq(schema.catalogItems.itemId, id))
          .limit(1)
        if (!row) return null
        if (row.unitPrice === null || row.currency === null) return null
        const currency = restored(Currency.create(row.currency))
        return {
          tenantId: row.tenantId,
          itemId: row.itemId,
          description: restored(LineDescription.create(row.description)),
          unitPrice: Money.fromAmount(row.unitPrice, currency),
          active: row.active === 1,
        }
      },
      recordItem: async (item) => {
        assertTenant(item.tenantId)
        await tx
          .insert(schema.catalogItems)
          .values({
            tenantId,
            itemId: item.itemId,
            description: item.description.value,
            unitPrice: null,
            currency: null,
            active: 1,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [schema.catalogItems.tenantId, schema.catalogItems.itemId],
            set: { description: item.description.value, active: 1, updatedAt: new Date() },
          })
      },
      recordPrice: async (itemId, unitPrice) => {
        await tx
          .update(schema.catalogItems)
          .set({
            unitPrice: unitPrice.amount,
            currency: unitPrice.currency.value,
            updatedAt: new Date(),
          })
          .where(eq(schema.catalogItems.itemId, itemId))
      },
      deactivate: async (itemId) => {
        await tx
          .update(schema.catalogItems)
          .set({ active: 0, updatedAt: new Date() })
          .where(eq(schema.catalogItems.itemId, itemId))
      },
    },
    events: { append: (event) => publish(tx, tenantId, event) },
  }
}
