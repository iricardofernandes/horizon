import { AsyncLocalStorage } from 'node:async_hooks'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type {
  CommandReceipt,
  EventOutcome,
  InventoryScope,
  ReceivedEvent,
} from '@/application/ports/unit-of-work'
import { InventoryUnitOfWork } from '@/application/ports/unit-of-work'
import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import {
  countDetail,
  listAdjustments,
  listCounts,
  listPolicies,
  listTransfers,
  listWarehouses,
} from './inventory-reads'
import { makeScope, type Transaction } from './inventory-store'
import * as schema from './schema'

export interface InventoryDatabaseOptions {
  readonly url: string
  readonly poolMax?: number
  readonly statementTimeoutMs?: number
}

/** Carries a refused command out of its transaction, so nothing it wrote is kept. */
class Refused<E> extends Error {
  constructor(readonly failure: E) {
    super('command refused')
  }
}

/** Owns the connection; only tenant-bound repositories leave this module (ADR 0017). */
export class InventoryDatabase extends InventoryUnitOfWork {
  readonly #client: ReturnType<typeof postgres>
  readonly #db
  readonly #transactions = new AsyncLocalStorage<{ tx: Transaction; tenantId: string }>()

  constructor(options: InventoryDatabaseOptions) {
    super()
    this.#client = postgres(options.url, {
      max: options.poolMax ?? 10,
      connect_timeout: 5,
      connection: { statement_timeout: options.statementTimeoutMs ?? 5000 },
    })
    this.#db = drizzle(this.#client, { schema })
  }

  async provisionTenant(tenantId: string): Promise<void> {
    await this.inTenant(tenantId, async () => {
      await this.currentTransaction()
        .insert(schema.tenants)
        .values({ id: tenantId })
        .onConflictDoNothing()
    })
  }

  async inTenant<T>(tenantId: string, work: (scope: InventoryScope) => Promise<T>): Promise<T> {
    if (this.#transactions.getStore())
      throw new Error('Nested tenant transactions are not supported')
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`)
      return this.#transactions.run({ tx, tenantId }, () => work(makeScope(tx, tenantId)))
    })
  }

  async once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: InventoryScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>> {
    try {
      return await this.inTenant(tenantId, async (scope) => {
        const tx = this.currentTransaction()
        // Claiming first makes a concurrent retry wait on this transaction, then see its receipt.
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
    work: (scope: InventoryScope) => Promise<T>,
  ): Promise<EventOutcome<T>> {
    return this.inTenant(tenantId, async (scope) => {
      const claimed = await this.currentTransaction()
        .insert(schema.inbox)
        .values({ ...event, tenantId })
        .onConflictDoNothing({ target: [schema.inbox.sourceModule, schema.inbox.eventId] })
        .returning({ eventId: schema.inbox.eventId })
      if (claimed.length === 0) return { processed: false as const }
      return { processed: true as const, value: await work(scope) }
    })
  }

  listWarehouseSnapshots(tenantId: string) {
    return this.read(tenantId, (tx) => listWarehouses(tx))
  }

  listTransfers(tenantId: string, page: { limit: number; offset: number }) {
    return this.read(tenantId, (tx) => listTransfers(tx, page))
  }

  listAdjustments(
    tenantId: string,
    filter: { status: string | null; warehouseId: string | null; limit: number; offset: number },
  ) {
    return this.read(tenantId, (tx) => listAdjustments(tx, filter))
  }

  listCounts(
    tenantId: string,
    filter: { status: string | null; warehouseId: string | null; limit: number; offset: number },
  ) {
    return this.read(tenantId, (tx) => listCounts(tx, filter))
  }

  countDetail(tenantId: string, id: string) {
    return this.read(tenantId, (tx) => countDetail(tx, id))
  }

  listPolicies(tenantId: string) {
    return this.read(tenantId, (tx) => listPolicies(tx))
  }

  async ping(): Promise<void> {
    await this.#db.execute(sql`select 1`)
  }

  async close(): Promise<void> {
    await this.#client.end({ timeout: 5 })
  }

  private currentTransaction(): Transaction {
    const current = this.#transactions.getStore()
    if (!current) throw new Error('This operation requires a tenant transaction')
    return current.tx
  }

  private read<T>(tenantId: string, query: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.inTenant(tenantId, () => query(this.currentTransaction()))
  }
}
