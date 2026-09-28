import type { RowKey } from '@/application/imports/ports'
import {
  type EventOutcome,
  type ReceivedEvent,
  type TenantScope,
  UnitOfWork,
} from '@/application/ports/unit-of-work'
import { Right } from '@/core/either'
import type { CatalogDatabase } from '@/infrastructure/database/drizzle/catalog-database'
import { markRowInTransaction } from '@/infrastructure/database/drizzle/import-store'

/**
 * The unit of work an importer writes one row through: when the use case succeeds, the
 * row is marked written in the same transaction, so a crash can never leave the record
 * written and the row waiting — or the other way round.
 */
export class RowWritingUnitOfWork extends UnitOfWork {
  constructor(
    private readonly database: CatalogDatabase,
    private readonly key: RowKey,
  ) {
    super()
  }

  inTenant<T>(tenantId: string, work: (scope: TenantScope) => Promise<T>): Promise<T> {
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

  processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: TenantScope) => Promise<T>,
  ): Promise<EventOutcome<T>> {
    return this.database.processEvent(tenantId, event, work)
  }
}
