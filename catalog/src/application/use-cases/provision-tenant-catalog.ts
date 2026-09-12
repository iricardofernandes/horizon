import { type Either, left, right } from '@/core/either'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { PriceList } from '@/domain/entities/price-list'
import { UnitOfMeasure } from '@/domain/entities/unit-of-measure'
import { CatalogName, Currency, UnitCode } from '@/domain/value-objects/catalog-values'
import type { Clock } from '../ports/clock'
import type { ReceivedEvent, TenantScope, UnitOfWork } from '../ports/unit-of-work'

export interface CatalogDefaults {
  /**
   * `identity.tenant.created` carries no currency, so the base price list is created in
   * a configured one. It is a starting point a tenant renames or replaces, not a claim
   * about where the tenant trades.
   */
  readonly priceListCurrency: string
  readonly priceListName?: string
}

export interface ProvisionTenantCatalogRequest {
  readonly tenantId: string
  readonly event: ReceivedEvent
}

/** Defined here rather than in configuration: these are catalogue facts, not knobs. */
const DEFAULT_UNITS: readonly { code: string; name: string; decimalPlaces: number }[] = [
  { code: 'UN', name: 'Unit', decimalPlaces: 0 },
  { code: 'KG', name: 'Kilogram', decimalPlaces: 3 },
  { code: 'L', name: 'Litre', decimalPlaces: 3 },
  { code: 'H', name: 'Hour', decimalPlaces: 2 },
]

/**
 * What a new tenant's catalogue starts as (the `identity.tenant.created` contract).
 *
 * Everything here is written under the inbox claim, so a redelivered event is a no-op,
 * and every step is also independently idempotent: a code or name that already exists is
 * left alone rather than duplicated or treated as an error. Both matter — the inbox
 * protects against the broker, the per-record checks protect against an operator running
 * provisioning by hand.
 */
export class ProvisionTenantCatalogUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly defaults: CatalogDefaults,
  ) {}

  async execute(
    request: ProvisionTenantCatalogRequest,
  ): Promise<Either<InvalidInputError, { provisioned: boolean }>> {
    const currency = Currency.create(this.defaults.priceListCurrency)
    if (currency.isLeft()) return left(currency.value)
    const listName = CatalogName.create(this.defaults.priceListName ?? 'Base')
    if (listName.isLeft()) return left(listName.value)

    // The tenant mirror is its own transaction: the inbox claim has a foreign key to it,
    // so it must exist before the claim can be written. Repeating it is harmless.
    await this.unitOfWork.provisionTenant(request.tenantId)
    const outcome = await this.unitOfWork.processEvent(
      request.tenantId,
      request.event,
      async (scope) => {
        await this.createUnits(scope, request.tenantId)
        await this.createPriceList(scope, request.tenantId, listName.value, currency.value)
      },
    )
    return right({ provisioned: outcome.processed })
  }

  private async createUnits(scope: TenantScope, tenantId: string): Promise<void> {
    for (const definition of DEFAULT_UNITS) {
      const code = UnitCode.create(definition.code)
      const name = CatalogName.create(definition.name)
      if (code.isLeft() || name.isLeft()) throw new Error('Invalid default unit definition')
      if (await scope.units.findByCode(code.value.value)) continue
      const now = this.clock.now()
      const unit = UnitOfMeasure.create({
        tenantId,
        code: code.value,
        name: name.value,
        decimalPlaces: definition.decimalPlaces,
        createdAt: now,
      })
      await scope.units.create(unit)
      await scope.audit.append({
        actor: { type: 'system', id: null },
        action: 'catalog.unit.created',
        subjectType: 'UnitOfMeasure',
        subjectId: unit.id.toString(),
        after: {
          code: code.value.value,
          name: name.value.value,
          decimalPlaces: definition.decimalPlaces,
        },
        occurredAt: now,
      })
    }
  }

  private async createPriceList(
    scope: TenantScope,
    tenantId: string,
    name: CatalogName,
    currency: Currency,
  ): Promise<void> {
    if (await scope.priceLists.findByName(name.value)) return
    const now = this.clock.now()
    const priceList = PriceList.create({ tenantId, name, currency, createdAt: now })
    await scope.priceLists.create(priceList)
    await scope.audit.append({
      actor: { type: 'system', id: null },
      action: 'catalog.price-list.created',
      subjectType: 'PriceList',
      subjectId: priceList.id.toString(),
      after: { name: name.value, currency: currency.value },
      occurredAt: now,
    })
  }
}
