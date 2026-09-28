import { and, desc, eq, isNull, or } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ApprovalDelegation } from '@/domain/controls/approval-delegation'
import type { DelegationsRepository } from '@/domain/controls/delegations-repository'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type Row = typeof schema.approvalDelegations.$inferSelect

function toDelegation(row: Row): ApprovalDelegation {
  return ApprovalDelegation.rehydrate(
    {
      tenantId: row.tenantId,
      permission: row.permission,
      delegatorId: row.delegatorId,
      delegateId: row.delegateId,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      reason: row.reason,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt,
      revokedBy: row.revokedBy,
    },
    new UniqueEntityID(row.id),
  )
}

/** Approval delegations, inside the tenant's transaction (ADR 0062). */
export function delegationsRepository(tx: Transaction, tenantId: string): DelegationsRepository {
  const table = schema.approvalDelegations
  return {
    create: async (delegation) => {
      const snapshot = delegation.toSnapshot()
      if (snapshot.tenantId !== tenantId) throw new Error('Delegation tenant does not match')
      await tx.insert(table).values(snapshot)
    },
    save: async (delegation) => {
      const snapshot = delegation.toSnapshot()
      await tx
        .update(table)
        .set({ revokedAt: snapshot.revokedAt, revokedBy: snapshot.revokedBy })
        .where(eq(table.id, snapshot.id))
    },
    findForUpdate: async (id) => {
      const [row] = await tx.select().from(table).where(eq(table.id, id)).for('update')
      return row ? toDelegation(row) : null
    },
    findFor: async (delegateId, permission) =>
      (
        await tx
          .select()
          .from(table)
          .where(
            and(
              eq(table.delegateId, delegateId),
              eq(table.permission, permission),
              isNull(table.revokedAt),
            ),
          )
          .orderBy(table.createdAt)
      ).map(toDelegation),
    list: async (person) =>
      (
        await tx
          .select()
          .from(table)
          .where(
            person === null
              ? undefined
              : or(eq(table.delegatorId, person), eq(table.delegateId, person)),
          )
          .orderBy(desc(table.createdAt))
          .limit(500)
      ).map(toDelegation),
  }
}
