import { randomBytes } from 'node:crypto'
import type { RowKey } from '@/application/imports/ports'
import { type PartiesScope, PartiesUnitOfWork } from '@/application/ports/unit-of-work'
import { Right } from '@/core/either'
import type { SecretBox } from '@/domain/services/secret-box'
import {
  markRowInTransaction,
  type RowCodec,
  type RowScope,
} from '@/infrastructure/database/drizzle/import-store'
import type { PartiesDatabase } from '@/infrastructure/database/drizzle/parties-database'

/**
 * An import row's cells are personal data (ADR 0026): sealed under a key kept on the job,
 * which retention destroys, so a cleared row cannot be read back from a backup either.
 */
export class SealedImportRows implements RowCodec {
  constructor(private readonly secretBox: SecretBox) {}

  newKey(): string {
    return randomBytes(32).toString('base64url')
  }

  seal(key: string | null, scope: RowScope, cells: readonly string[]): string {
    if (!key) throw new Error('Import rows are sealed under the job key')
    return this.secretBox.seal(secretOf(key, scope), JSON.stringify(cells))
  }

  open(key: string | null, scope: RowScope, stored: string): readonly string[] {
    if (!key) return []
    const plaintext = this.secretBox.open(secretOf(key, scope), stored)
    if (plaintext === null) throw new Error('Import row authentication failed')
    return JSON.parse(plaintext) as string[]
  }
}

function secretOf(key: string, scope: RowScope): string {
  return `${scope.tenantId}:${scope.jobId}:${scope.line}:import:${key}`
}

/**
 * The unit of work an importer writes one row through: when the use case succeeds, the
 * row is marked written in the same transaction, so a crash can never leave the party
 * written and the row waiting — or the other way round.
 */
export class RowWritingUnitOfWork extends PartiesUnitOfWork {
  constructor(
    private readonly database: PartiesDatabase,
    private readonly key: RowKey,
  ) {
    super()
  }

  inTenant<T>(tenantId: string, work: (scope: PartiesScope) => Promise<T>): Promise<T> {
    return this.database.inTenant(tenantId, async (scope) => {
      const result = await work(scope)
      if (result instanceof Right)
        await markRowInTransaction(this.database, { tenantId, ...this.key })
      return result
    })
  }
}
