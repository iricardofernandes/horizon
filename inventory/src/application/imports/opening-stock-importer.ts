import { type Either, left, right } from '@/core/either'
import type { UseCaseError } from '@/core/errors/use-case-error'
import type { RowIssue } from '@/domain/imports/import-job'
import {
  dateOf,
  decimalOf,
  type ImportFieldSpec,
  type ImportRecord,
  issue,
  listOf,
  valueIn,
} from '@/domain/imports/import-values'
import { Currency, Quantity } from '@/domain/value-objects/inventory-values'
import { ExpiryDate, LotCode, SerialNumber } from '@/domain/value-objects/tracking'
import type { Clock } from '../ports/clock'
import type { InventoryUnitOfWork } from '../ports/unit-of-work'
import { ReceiveStockUseCase } from '../use-cases/manage-inventory'
import type { ImportActor, ImportSession, RowImporter, RowKey } from './ports'

const FIELDS: readonly ImportFieldSpec[] = [
  {
    name: 'warehouse',
    required: true,
    aliases: ['deposito', 'depósito', 'local', 'armazem', 'location'],
    description: 'The name of an active warehouse',
  },
  {
    name: 'itemId',
    required: true,
    aliases: ['item', 'id do item', 'item id', 'id'],
    description: 'The Catalog item id (a Catalog items export carries it next to the SKU)',
  },
  {
    name: 'quantity',
    required: true,
    aliases: ['quantidade', 'qtd', 'saldo', 'qty'],
    description: 'The quantity on hand',
  },
  {
    name: 'unitCost',
    required: true,
    aliases: ['custo unitario', 'custo unitário', 'custo', 'unit cost', 'cost'],
    description: 'What one unit cost, as a decimal',
  },
  { name: 'currency', required: true, aliases: ['moeda'], description: 'Three-letter currency' },
  {
    name: 'lot',
    required: false,
    aliases: ['lote'],
    description: 'The lot, for items tracked by lot',
  },
  {
    name: 'expiresOn',
    required: false,
    aliases: ['validade', 'vencimento', 'expiry', 'expires'],
    description: 'The lot’s expiry date',
  },
  {
    name: 'serials',
    required: false,
    aliases: ['series', 'séries', 'numeros de serie', 'serial', 'serial numbers'],
    description: 'Serial numbers separated by |, one per unit',
  },
]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface OpeningStockCommand {
  readonly warehouseId: string
  readonly itemId: string
  readonly quantity: string
  readonly unitCost: string
  readonly currency: string
  readonly lot: { readonly code: string; readonly expiresOn: string | null } | null
  readonly serials: readonly string[]
}

function issueOf(error: UseCaseError & { field?: string }): RowIssue {
  return issue(error.field?.split('/').filter(Boolean)[0] ?? null, error.message)
}

/**
 * A decimal amount as integer minor units of its currency, refusing more places than the
 * currency has: rounding a cost on the way in would change it.
 */
export function minorUnitsOf(decimal: string, currency: string): string | null {
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal)
  if (!match) return null
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > digits) return null
  const whole = BigInt(match[1] ?? '0') * 10n ** BigInt(digits)
  return (whole + BigInt(fraction.padEnd(digits, '0') || '0')).toString()
}

function serialsOf(record: ImportRecord, issues: RowIssue[]): string[] {
  return listOf(valueIn(record, 'serials')).map((serial) => {
    const parsed = SerialNumber.create(serial)
    if (parsed.isLeft()) issues.push(issue('serials', parsed.value.message))
    return parsed.isRight() ? parsed.value.value : serial
  })
}

/**
 * Opening balances at go-live (Phase 64): a quantity of an item in a warehouse, at a unit
 * cost, and the lot or serials the item's tracking asks for. Each row is a receipt through
 * `ReceiveStockUseCase`, so the balance, its movement and its event are the ones a receipt
 * through the API would make — and the item's tracking policy decides what it needs.
 */
export class OpeningStockImporter implements RowImporter<OpeningStockCommand> {
  readonly kind = 'opening-stock'
  readonly fields = FIELDS

  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
    private readonly rowUnitOfWork: (key: RowKey) => InventoryUnitOfWork,
  ) {}

  async session(context: ImportActor): Promise<ImportSession<OpeningStockCommand>> {
    const warehouses = await this.unitOfWork.inTenant(context.tenantId, (scope) =>
      scope.warehouses.list(),
    )
    const active = new Map(
      warehouses
        .filter((warehouse) => warehouse.isActive())
        .map((warehouse) => [warehouse.name(), warehouse.id.toString()]),
    )
    return {
      validate: (record) => this.validate(record, active, context),
      uniqueKey: (command) =>
        [command.warehouseId, command.itemId, command.lot?.code ?? '', ...command.serials].join(
          '\u0000',
        ),
    }
  }

  private validate(
    record: ImportRecord,
    warehouses: ReadonlyMap<string, string>,
    context: ImportActor,
  ): Either<readonly RowIssue[], OpeningStockCommand> {
    const issues: RowIssue[] = []
    const name = valueIn(record, 'warehouse') ?? ''
    const warehouseId = warehouses.get(name.trim())
    if (!warehouseId) issues.push(issue('warehouse', `no active warehouse is named "${name}"`))
    const itemId = valueIn(record, 'itemId') ?? ''
    if (!UUID.test(itemId)) issues.push(issue('itemId', 'must be the item’s id'))
    const amounts = this.amountsOf(record, context, issues)
    const lot = this.lotOf(record, context, issues)
    const serials = serialsOf(record, issues)
    if (lot && serials.length > 0)
      issues.push(issue('serials', 'a row has a lot or serials, not both'))
    if (issues.length > 0 || !warehouseId || !amounts) return left(issues)
    return right({ warehouseId, itemId: itemId.toLowerCase(), ...amounts, lot, serials })
  }

  /** The quantity, and the unit cost in minor units of its currency. */
  private amountsOf(record: ImportRecord, context: ImportActor, issues: RowIssue[]) {
    const quantity = decimalOf(valueIn(record, 'quantity') ?? '', context.numbers)
    if (quantity === null || Quantity.create(quantity).isLeft())
      issues.push(issue('quantity', 'must be a non-negative quantity with at most 6 decimals'))
    const currency = Currency.create(valueIn(record, 'currency') ?? '')
    if (currency.isLeft()) {
      issues.push(issue('currency', currency.value.message))
      return null
    }
    const cost = decimalOf(valueIn(record, 'unitCost') ?? '', context.numbers)
    const unitCost = cost === null ? null : minorUnitsOf(cost, currency.value.value)
    if (unitCost === null)
      issues.push(issue('unitCost', 'must be a non-negative amount with the currency’s decimals'))
    if (quantity === null || unitCost === null) return null
    return { quantity, unitCost, currency: currency.value.value }
  }

  private lotOf(record: ImportRecord, context: ImportActor, issues: RowIssue[]) {
    const code = valueIn(record, 'lot')
    const expiry = valueIn(record, 'expiresOn')
    if (code === null) {
      if (expiry !== null) issues.push(issue('expiresOn', 'an expiry belongs to a lot'))
      return null
    }
    const lot = LotCode.create(code)
    if (lot.isLeft()) issues.push(issue('lot', lot.value.message))
    const date = expiry === null ? null : dateOf(expiry, context.dates)
    if (expiry !== null && (date === null || ExpiryDate.create(date).isLeft()))
      issues.push(issue('expiresOn', 'must be a date'))
    return lot.isRight() ? { code: lot.value.value, expiresOn: date } : null
  }

  async write(
    command: OpeningStockCommand,
    key: RowKey,
    context: ImportActor,
  ): Promise<Either<readonly RowIssue[], string>> {
    const receive = new ReceiveStockUseCase(this.rowUnitOfWork(key), this.clock)
    const outcome = await receive.execute({
      tenantId: context.tenantId,
      warehouseId: command.warehouseId,
      itemId: command.itemId,
      quantity: command.quantity,
      unitCost: command.unitCost,
      currency: command.currency,
      lots: command.lot
        ? [{ code: command.lot.code, expiresOn: command.lot.expiresOn, quantity: command.quantity }]
        : null,
      serials: command.serials.length > 0 ? command.serials : null,
    })
    return outcome.isRight() ? right(outcome.value.balanceId) : left([issueOf(outcome.value)])
  }
}
