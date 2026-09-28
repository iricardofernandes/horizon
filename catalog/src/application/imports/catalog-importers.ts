import { type Either, left, right } from '@/core/either'
import type { UseCaseError } from '@/core/errors/use-case-error'
import type { Page, PaginationParams } from '@/core/repositories/pagination-params'
import type { CatalogItemKind } from '@/domain/entities/catalog-item'
import type { RowIssue } from '@/domain/imports/import-job'
import {
  decimalOf,
  type ImportFieldSpec,
  type ImportRecord,
  issue,
  normalizeHeader,
  valueIn,
} from '@/domain/imports/import-values'
import {
  CatalogName,
  Currency,
  NcmCode,
  Sku,
  UnitCode,
} from '@/domain/value-objects/catalog-values'
import type { Clock } from '../ports/clock'
import type { TenantScope, UnitOfWork } from '../ports/unit-of-work'
import { CreateCatalogItemUseCase } from '../use-cases/create-catalog-item'
import { CreateUnitUseCase } from '../use-cases/create-unit'
import { CreatePriceListUseCase, SetPriceUseCase } from '../use-cases/manage-prices'
import type { ImportActor, ImportSession, RowImporter, RowKey } from './ports'

type RowUnitOfWork = (key: RowKey) => UnitOfWork

const PAGE = 100

/** Every page of a small, tenant-wide list: units or price lists. */
async function everything<T>(
  list: (params: PaginationParams) => Promise<Page<T>>,
): Promise<readonly T[]> {
  const all: T[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await list(cursor === undefined ? { limit: PAGE } : { limit: PAGE, cursor })
    all.push(...page.items)
    if (!page.hasMore || page.nextCursor === undefined) return all
    cursor = page.nextCursor
  }
}

/** The use case's JSON pointer, as the importer's field name. */
function issueOf(error: UseCaseError & { field?: string }, fallback: string | null = null) {
  const field = error.field?.split('/').filter(Boolean)[0] ?? fallback
  return issue(field, error.message)
}

function auditOf(context: ImportActor) {
  return { actor: { type: 'user' as const, id: context.actor }, requestId: null }
}

function collect<T>(issues: RowIssue[], outcome: Either<UseCaseError, T>, field: string) {
  if (outcome.isLeft()) issues.push(issue(field, outcome.value.message))
  return outcome.isRight() ? outcome.value : null
}

/**
 * A decimal amount as integer minor units of its currency, refusing more places than the
 * currency has: rounding a price on the way in would change it.
 */
export function minorUnitsOf(decimal: string, currency: string): string | null {
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal)
  if (!match) return null
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > digits) return null
  return (
    BigInt(match[1] ?? '0') * 10n ** BigInt(digits) +
    BigInt(fraction.padEnd(digits, '0') || '0')
  ).toString()
}

const UNIT_FIELDS: readonly ImportFieldSpec[] = [
  {
    name: 'code',
    required: true,
    aliases: ['codigo', 'sigla', 'unidade'],
    description: 'Up to 6 letters or digits',
  },
  { name: 'name', required: true, aliases: ['nome', 'descricao'], description: 'The unit name' },
  {
    name: 'decimalPlaces',
    required: false,
    aliases: ['casas decimais', 'decimais', 'decimals'],
    description: 'How many decimal places a quantity may have (0 to 6); 0 when left out',
  },
]

export interface UnitCommand {
  readonly code: string
  readonly name: string
  readonly decimalPlaces: number
}

/** Units of measure (Phase 64), written through `CreateUnitUseCase`. */
export class UnitImporter implements RowImporter<UnitCommand> {
  readonly kind = 'units'
  readonly fields = UNIT_FIELDS

  constructor(
    private readonly clock: Clock,
    private readonly rowUnitOfWork: RowUnitOfWork,
  ) {}

  async session(): Promise<ImportSession<UnitCommand>> {
    return {
      validate: (record) => {
        const issues: RowIssue[] = []
        const code = collect(issues, UnitCode.create(valueIn(record, 'code') ?? ''), 'code')
        const name = collect(issues, CatalogName.create(valueIn(record, 'name') ?? ''), 'name')
        const places = valueIn(record, 'decimalPlaces') ?? '0'
        if (!/^[0-6]$/.test(places))
          issues.push(issue('decimalPlaces', 'must be a whole number from 0 to 6'))
        if (issues.length > 0 || !code || !name) return left(issues)
        return right({ code: code.value, name: name.value, decimalPlaces: Number(places) })
      },
      uniqueKey: (command) => command.code,
    }
  }

  async write(
    command: UnitCommand,
    key: RowKey,
    context: ImportActor,
  ): Promise<Either<readonly RowIssue[], string>> {
    const outcome = await new CreateUnitUseCase(this.rowUnitOfWork(key), this.clock).execute({
      tenantId: context.tenantId,
      ...auditOf(context),
      ...command,
    })
    return outcome.isRight() ? right(outcome.value.unitId) : left([issueOf(outcome.value)])
  }
}

const KINDS: Readonly<Record<string, CatalogItemKind>> = {
  product: 'product',
  produto: 'product',
  service: 'service',
  servico: 'service',
}

const ITEM_FIELDS: readonly ImportFieldSpec[] = [
  {
    name: 'sku',
    required: true,
    aliases: ['codigo', 'código', 'referencia'],
    description: 'The item code',
  },
  {
    name: 'name',
    required: true,
    aliases: ['nome', 'descricao', 'descrição'],
    description: 'The item name',
  },
  {
    name: 'kind',
    required: false,
    aliases: ['tipo'],
    description: 'product or service; product when left out',
  },
  {
    name: 'unit',
    required: true,
    aliases: ['unidade', 'un', 'unit code'],
    description: 'The code of an active unit',
  },
  { name: 'ncm', required: false, aliases: [], description: 'The 8-digit NCM of a product' },
]

export interface ItemCommand {
  readonly sku: string
  readonly name: string
  readonly kind: CatalogItemKind
  readonly unitId: string
  readonly ncm: string | null
}

/** Items (Phase 64), with their unit by code, written through `CreateCatalogItemUseCase`. */
export class ItemImporter implements RowImporter<ItemCommand> {
  readonly kind = 'items'
  readonly fields = ITEM_FIELDS

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly rowUnitOfWork: RowUnitOfWork,
  ) {}

  async session(context: ImportActor): Promise<ImportSession<ItemCommand>> {
    const units = await this.unitOfWork.inTenant(context.tenantId, (scope) =>
      everything((params) => scope.units.list(params)),
    )
    const active = new Map(
      units.filter((unit) => unit.isActive()).map((unit) => [unit.code(), unit.id.toString()]),
    )
    return {
      validate: (record) => this.validate(record, active),
      uniqueKey: (command) => command.sku,
    }
  }

  private validate(
    record: ImportRecord,
    units: ReadonlyMap<string, string>,
  ): Either<readonly RowIssue[], ItemCommand> {
    const issues: RowIssue[] = []
    const sku = collect(issues, Sku.create(valueIn(record, 'sku') ?? ''), 'sku')
    const name = collect(issues, CatalogName.create(valueIn(record, 'name') ?? ''), 'name')
    const kind = KINDS[normalizeHeader(valueIn(record, 'kind') ?? 'product')]
    if (!kind) issues.push(issue('kind', 'must be product or service'))
    const unitCode = (valueIn(record, 'unit') ?? '').toUpperCase()
    const unitId = units.get(unitCode)
    if (!unitId) issues.push(issue('unit', `no active unit has the code "${unitCode}"`))
    const ncmText = valueIn(record, 'ncm')
    // A spreadsheet that stored the NCM as a number dropped its leading zero.
    const ncmDigits = ncmText !== null && /^\d{7}$/.test(ncmText) ? `0${ncmText}` : ncmText
    const ncm = ncmDigits === null ? null : collect(issues, NcmCode.create(ncmDigits), 'ncm')
    if (issues.length > 0 || !sku || !name || !kind || !unitId) return left(issues)
    return right({ sku: sku.value, name: name.value, kind, unitId, ncm: ncm?.value ?? null })
  }

  async write(
    command: ItemCommand,
    key: RowKey,
    context: ImportActor,
  ): Promise<Either<readonly RowIssue[], string>> {
    const outcome = await new CreateCatalogItemUseCase(this.rowUnitOfWork(key), this.clock).execute(
      { tenantId: context.tenantId, ...auditOf(context), ...command },
    )
    return outcome.isRight() ? right(outcome.value.itemId) : left([issueOf(outcome.value)])
  }
}

const PRICE_FIELDS: readonly ImportFieldSpec[] = [
  {
    name: 'priceList',
    required: true,
    aliases: ['lista', 'lista de preco', 'tabela', 'price list'],
    description: 'The price list name; created when it does not exist',
  },
  {
    name: 'currency',
    required: true,
    aliases: ['moeda'],
    description: 'Three-letter currency of the list',
  },
  {
    name: 'sku',
    required: true,
    aliases: ['codigo', 'código', 'item'],
    description: 'The SKU of an active item',
  },
  {
    name: 'price',
    required: true,
    aliases: ['preco', 'preço', 'valor', 'amount'],
    description: 'The price, as a decimal',
  },
]

export interface PriceCommand {
  readonly priceList: string
  readonly currency: string
  readonly sku: string
  readonly amount: string
}

/**
 * Prices (Phase 64): an item by SKU in a list by name, written through `SetPriceUseCase`.
 * A list the file names but the catalogue lacks is created first, with the file's
 * currency; an item the catalogue lacks refuses the row when it is written.
 */
export class PriceImporter implements RowImporter<PriceCommand> {
  readonly kind = 'prices'
  readonly fields = PRICE_FIELDS

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly rowUnitOfWork: RowUnitOfWork,
  ) {}

  async session(context: ImportActor): Promise<ImportSession<PriceCommand>> {
    const lists = await this.unitOfWork.inTenant(context.tenantId, (scope) =>
      everything((params) => scope.priceLists.list(params)),
    )
    const currencies = new Map(lists.map((list) => [list.name(), list.currency()]))
    return {
      validate: (record) => this.validate(record, currencies, context),
      uniqueKey: (command) => `${command.priceList}\u0000${command.sku}`,
    }
  }

  private validate(
    record: ImportRecord,
    currencies: ReadonlyMap<string, string>,
    context: ImportActor,
  ): Either<readonly RowIssue[], PriceCommand> {
    const issues: RowIssue[] = []
    const list = collect(
      issues,
      CatalogName.create(valueIn(record, 'priceList') ?? ''),
      'priceList',
    )
    const currency = collect(issues, Currency.create(valueIn(record, 'currency') ?? ''), 'currency')
    const sku = collect(issues, Sku.create(valueIn(record, 'sku') ?? ''), 'sku')
    const expected = list ? currencies.get(list.value) : undefined
    if (currency && expected && expected !== currency.value)
      issues.push(issue('currency', `the list "${list?.value}" is in ${expected}`))
    const decimal = decimalOf(valueIn(record, 'price') ?? '', context.numbers)
    const amount = decimal && currency ? minorUnitsOf(decimal, currency.value) : null
    if (currency && amount === null)
      issues.push(issue('price', 'must be a non-negative amount with the currency’s decimals'))
    if (issues.length > 0 || !list || !currency || !sku || amount === null) return left(issues)
    return right({ priceList: list.value, currency: currency.value, sku: sku.value, amount })
  }

  async write(
    command: PriceCommand,
    key: RowKey,
    context: ImportActor,
  ): Promise<Either<readonly RowIssue[], string>> {
    const found = await this.unitOfWork.inTenant(context.tenantId, (scope) =>
      this.find(scope, command),
    )
    let priceListId = found.priceListId
    if (priceListId === null) {
      const created = await new CreatePriceListUseCase(this.unitOfWork, this.clock).execute({
        tenantId: context.tenantId,
        ...auditOf(context),
        name: command.priceList,
        currency: command.currency,
      })
      // Another row may have created it a moment ago; the name is unique either way.
      priceListId = created.isRight()
        ? created.value.priceListId
        : (await this.unitOfWork.inTenant(context.tenantId, (scope) => this.find(scope, command)))
            .priceListId
    }
    if (priceListId === null)
      return left([issue('priceList', 'the price list could not be created')])
    if (found.itemId === null)
      return left([issue('sku', `no active item has the SKU "${command.sku}"`)])
    const outcome = await new SetPriceUseCase(this.rowUnitOfWork(key), this.clock).execute({
      tenantId: context.tenantId,
      ...auditOf(context),
      priceListId,
      itemId: found.itemId,
      amount: command.amount,
      currency: command.currency,
    })
    return outcome.isRight() ? right(priceListId) : left([issueOf(outcome.value)])
  }

  private async find(scope: TenantScope, command: PriceCommand) {
    const [list, item] = await Promise.all([
      scope.priceLists.findByName(command.priceList),
      scope.items.findBySku(command.sku),
    ])
    return {
      priceListId: list?.id.toString() ?? null,
      itemId: item?.isActive() ? item.id.toString() : null,
    }
  }
}
