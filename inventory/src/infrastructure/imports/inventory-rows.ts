import type { RowKey } from '@/application/imports/ports'
import type { CommandReceipt, EventOutcome, ReceivedEvent } from '@/application/ports/unit-of-work'
import { type InventoryScope, InventoryUnitOfWork } from '@/application/ports/unit-of-work'
import { type Either, Right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import { markRowInTransaction } from '@/infrastructure/database/drizzle/import-store'
import type { InventoryDatabase } from '@/infrastructure/database/drizzle/inventory-database'

/**
 * The unit of work an importer writes one row through: when the use case succeeds, the
 * row is marked written in the same transaction, so a crash can never leave the write
 * done and the row waiting — or the other way round.
 */
export class RowWritingUnitOfWork extends InventoryUnitOfWork {
  constructor(
    private readonly database: InventoryDatabase,
    private readonly key: RowKey,
  ) {
    super()
  }

  inTenant<T>(tenantId: string, work: (scope: InventoryScope) => Promise<T>): Promise<T> {
    return this.database.inTenant(tenantId, async (scope) => {
      const result = await work(scope)
      if (result instanceof Right)
        await markRowInTransaction(this.database, { tenantId, ...this.key })
      return result
    })
  }

  provisionTenant(tenantId: string): Promise<void> {
    return this.database.provisionTenant(tenantId)
  }

  once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: InventoryScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>> {
    return this.database.once(tenantId, receipt, work)
  }

  processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: InventoryScope) => Promise<T>,
  ): Promise<EventOutcome<T>> {
    return this.database.processEvent(tenantId, event, work)
  }
}
