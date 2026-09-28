import type { RowKey } from '@/application/imports/ports'
import {
  type CommandReceipt,
  type EventOutcome,
  type FinancialScope,
  FinancialUnitOfWork,
  type ReceivedEvent,
} from '@/application/ports/unit-of-work'
import { type Either, Right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type { FinancialDatabase } from '@/infrastructure/database/drizzle/financial-database'
import { markRowInTransaction } from '@/infrastructure/database/drizzle/import-store'

/**
 * The unit of work a title row is finished through — its post, or its approval request:
 * when that succeeds, the row is marked written in the same transaction, so the two commit
 * together. A post replayed from its receipt runs nothing, and the job marks the row.
 */
export class RowWritingUnitOfWork extends FinancialUnitOfWork {
  constructor(
    private readonly database: FinancialDatabase,
    private readonly key: RowKey,
  ) {
    super()
  }

  inTenant<T>(tenantId: string, work: (scope: FinancialScope) => Promise<T>): Promise<T> {
    return this.database.inTenant(tenantId, async (scope) => {
      const result = await work(scope)
      if (result instanceof Right)
        await markRowInTransaction(this.database, { tenantId, ...this.key })
      return result
    })
  }

  once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: FinancialScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>> {
    return this.database.once(tenantId, receipt, async (scope) => {
      const result = await work(scope)
      if (result instanceof Right)
        await markRowInTransaction(this.database, { tenantId, ...this.key })
      return result
    })
  }

  processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: FinancialScope) => Promise<T>,
  ): Promise<EventOutcome<T>> {
    return this.database.processEvent(tenantId, event, work)
  }
}
