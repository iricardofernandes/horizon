import { AsyncLocalStorage } from 'node:async_hooks'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { type FinancialScope, FinancialUnitOfWork } from '@/application/ports/unit-of-work'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import {
  AnalyticDimension,
  DIMENSION_KINDS,
  type DimensionKind,
  type DimensionSnapshot,
} from '@/domain/entities/analytic-dimension'
import {
  CATEGORY_NATURES,
  type CategoryNature,
  type CategorySnapshot,
  FinancialCategory,
} from '@/domain/entities/financial-category'
import {
  PAYMENT_METHOD_KINDS,
  PaymentMethod,
  type PaymentMethodKind,
  type PaymentMethodSnapshot,
} from '@/domain/entities/payment-method'
import { PaymentTerm, type PaymentTermSnapshot } from '@/domain/entities/payment-term'
import { Code, Name, Share } from '@/domain/value-objects/financial-values'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface FinancialDatabaseOptions {
  readonly url: string
  readonly poolMax?: number
  readonly statementTimeoutMs?: number
}

/** Owns the connection; only tenant-bound repositories leave this module (ADR 0017). */
export class FinancialDatabase extends FinancialUnitOfWork {
  readonly #client: ReturnType<typeof postgres>
  readonly #db: Database
  readonly #transactions = new AsyncLocalStorage<{ tx: Transaction }>()

  constructor(options: FinancialDatabaseOptions) {
    super()
    this.#client = postgres(options.url, {
      max: options.poolMax ?? 10,
      connect_timeout: 5,
      connection: { statement_timeout: options.statementTimeoutMs ?? 5000 },
    })
    this.#db = drizzle(this.#client, { schema })
  }

  async inTenant<T>(tenantId: string, work: (scope: FinancialScope) => Promise<T>): Promise<T> {
    if (this.#transactions.getStore())
      throw new Error('Nested tenant transactions are not supported')
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`)
      await tx.insert(schema.tenants).values({ id: tenantId }).onConflictDoNothing()
      return this.#transactions.run({ tx }, () => work(makeScope(tx, tenantId)))
    })
  }

  /** Read models for the HTTP boundary, ordered the way people scan them: by code. */
  listCategories(tenantId: string): Promise<readonly CategorySnapshot[]> {
    return this.read(tenantId, async (tx) =>
      (
        await tx
          .select()
          .from(schema.financialCategories)
          .orderBy(asc(schema.financialCategories.code))
      ).map((row) => mapCategory(row).toSnapshot()),
    )
  }

  listDimensions(tenantId: string, kind?: DimensionKind): Promise<readonly DimensionSnapshot[]> {
    return this.read(tenantId, async (tx) =>
      (
        await tx
          .select()
          .from(schema.analyticDimensions)
          .where(kind === undefined ? undefined : eq(schema.analyticDimensions.kind, kind))
          .orderBy(asc(schema.analyticDimensions.kind), asc(schema.analyticDimensions.code))
      ).map((row) => mapDimension(row).toSnapshot()),
    )
  }

  listPaymentMethods(tenantId: string): Promise<readonly PaymentMethodSnapshot[]> {
    return this.read(tenantId, async (tx) =>
      (await tx.select().from(schema.paymentMethods).orderBy(asc(schema.paymentMethods.code))).map(
        (row) => mapPaymentMethod(row).toSnapshot(),
      ),
    )
  }

  listPaymentTerms(tenantId: string): Promise<readonly PaymentTermSnapshot[]> {
    return this.read(tenantId, async (tx) =>
      (await tx.select().from(schema.paymentTerms).orderBy(asc(schema.paymentTerms.name))).map(
        (row) => mapPaymentTerm(row).toSnapshot(),
      ),
    )
  }

  async ping(): Promise<void> {
    await this.#db.execute(sql`select 1`)
  }

  async close(): Promise<void> {
    await this.#client.end({ timeout: 5 })
  }

  private read<T>(tenantId: string, query: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.inTenant(tenantId, async () => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Reads require a tenant transaction')
      return query(current.tx)
    })
  }
}

function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted financial value', { cause: result.value })
  return result.value
}

function oneOf<T extends string>(allowed: readonly T[], value: string, what: string): T {
  if (!allowed.includes(value as T)) throw new Error(`Invalid persisted ${what}`)
  return value as T
}

function mapCategory(row: typeof schema.financialCategories.$inferSelect): FinancialCategory {
  return FinancialCategory.rehydrate(
    {
      tenantId: row.tenantId,
      code: restored(Code.create(row.code)),
      name: restored(Name.create(row.name)),
      nature: oneOf<CategoryNature>(CATEGORY_NATURES, row.nature, 'category nature'),
      parentId: row.parentId,
      depth: row.depth,
      active: row.active,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapDimension(row: typeof schema.analyticDimensions.$inferSelect): AnalyticDimension {
  return AnalyticDimension.rehydrate(
    {
      tenantId: row.tenantId,
      kind: oneOf<DimensionKind>(DIMENSION_KINDS, row.kind, 'dimension kind'),
      code: restored(Code.create(row.code)),
      name: restored(Name.create(row.name)),
      active: row.active,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapPaymentMethod(row: typeof schema.paymentMethods.$inferSelect): PaymentMethod {
  return PaymentMethod.rehydrate(
    {
      tenantId: row.tenantId,
      kind: oneOf<PaymentMethodKind>(PAYMENT_METHOD_KINDS, row.kind, 'payment method kind'),
      code: restored(Code.create(row.code)),
      name: restored(Name.create(row.name)),
      active: row.active,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapPaymentTerm(row: typeof schema.paymentTerms.$inferSelect): PaymentTerm {
  return PaymentTerm.rehydrate(
    {
      tenantId: row.tenantId,
      name: restored(Name.create(row.name)),
      installments: row.installments.map((installment) => ({
        dueInDays: installment.dueInDays,
        share: restored(Share.fromBasisPoints(installment.basisPoints)),
      })),
      active: row.active,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function makeScope(tx: Transaction, tenantId: string): FinancialScope {
  const assertTenant = (actual: string) => {
    if (actual !== tenantId) throw new Error('Aggregate tenant does not match transaction')
  }
  const status =
    <
      T extends {
        toSnapshot(): { tenantId: string; active: boolean; updatedAt: Date; id: string }
      },
    >(
      table:
        | typeof schema.financialCategories
        | typeof schema.analyticDimensions
        | typeof schema.paymentMethods
        | typeof schema.paymentTerms,
    ) =>
    async (entry: T) => {
      const row = entry.toSnapshot()
      assertTenant(row.tenantId)
      await tx
        .update(table)
        .set({ active: row.active, updatedAt: row.updatedAt })
        .where(eq(table.id, row.id))
    }
  return {
    tenantId,
    categories: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.financialCategories)
          .where(eq(schema.financialCategories.id, id))
          .limit(1)
        return row ? mapCategory(row) : null
      },
      findByCode: async (code) => {
        const [row] = await tx
          .select()
          .from(schema.financialCategories)
          .where(eq(schema.financialCategories.code, code))
          .limit(1)
        return row ? mapCategory(row) : null
      },
      create: async (category) => {
        const row = category.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.financialCategories).values(row)
      },
      save: status(schema.financialCategories),
    },
    dimensions: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.analyticDimensions)
          .where(eq(schema.analyticDimensions.id, id))
          .limit(1)
        return row ? mapDimension(row) : null
      },
      findByIds: async (ids) =>
        ids.length === 0
          ? []
          : (
              await tx
                .select()
                .from(schema.analyticDimensions)
                .where(inArray(schema.analyticDimensions.id, [...ids]))
            ).map(mapDimension),
      findByCode: async (kind, code) => {
        const [row] = await tx
          .select()
          .from(schema.analyticDimensions)
          .where(
            and(eq(schema.analyticDimensions.kind, kind), eq(schema.analyticDimensions.code, code)),
          )
          .limit(1)
        return row ? mapDimension(row) : null
      },
      create: async (dimension) => {
        const row = dimension.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.analyticDimensions).values(row)
      },
      save: status(schema.analyticDimensions),
    },
    paymentMethods: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.paymentMethods)
          .where(eq(schema.paymentMethods.id, id))
          .limit(1)
        return row ? mapPaymentMethod(row) : null
      },
      findByCode: async (code) => {
        const [row] = await tx
          .select()
          .from(schema.paymentMethods)
          .where(eq(schema.paymentMethods.code, code))
          .limit(1)
        return row ? mapPaymentMethod(row) : null
      },
      create: async (method) => {
        const row = method.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.paymentMethods).values(row)
      },
      save: status(schema.paymentMethods),
    },
    paymentTerms: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.paymentTerms)
          .where(eq(schema.paymentTerms.id, id))
          .limit(1)
        return row ? mapPaymentTerm(row) : null
      },
      findByName: async (name) => {
        const [row] = await tx
          .select()
          .from(schema.paymentTerms)
          .where(eq(schema.paymentTerms.name, name))
          .limit(1)
        return row ? mapPaymentTerm(row) : null
      },
      create: async (term) => {
        const row = term.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.paymentTerms).values({ ...row, installments: [...row.installments] })
      },
      save: status(schema.paymentTerms),
    },
  }
}
