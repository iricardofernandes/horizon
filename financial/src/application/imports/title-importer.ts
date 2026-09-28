import { type Either, left, right } from '@/core/either'
import type { UseCaseError } from '@/core/errors/use-case-error'
import type { TitleDirection } from '@/domain/entities/title'
import type { RowIssue } from '@/domain/imports/import-job'
import {
  dateOf,
  decimalOf,
  type ImportFieldSpec,
  type ImportRecord,
  issue,
  valueIn,
} from '@/domain/imports/import-values'
import type { Clock } from '../ports/clock'
import type { FinancialUnitOfWork } from '../ports/unit-of-work'
import { DecidePayableApprovalUseCase } from '../use-cases/approve-payables'
import {
  approvalRequired,
  CancelTitleUseCase,
  DraftTitleUseCase,
  PostTitleUseCase,
} from '../use-cases/manage-titles'
import { type TermsInput, termsOf } from '../use-cases/title-inputs'
import type { ImportActor, ImportSession, RowImporter, RowKey } from './ports'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const FIELDS: readonly ImportFieldSpec[] = [
  {
    name: 'partyId',
    required: true,
    aliases: ['parceiro', 'id do parceiro', 'party', 'party id', 'cliente', 'fornecedor'],
    description: 'The Parties id of a customer (receivables) or supplier (payables)',
  },
  {
    name: 'documentNumber',
    required: true,
    aliases: ['documento', 'numero', 'número', 'nota', 'document', 'number'],
    description: 'The invoice or bill number',
  },
  {
    name: 'description',
    required: false,
    aliases: ['descricao', 'descrição', 'historico', 'histórico', 'memo'],
    description: 'A note for the title',
  },
  {
    name: 'issuedOn',
    required: true,
    aliases: ['emissao', 'emissão', 'data de emissao', 'issued', 'issue date'],
    description: 'The issue date',
  },
  {
    name: 'dueOn',
    required: true,
    aliases: ['vencimento', 'data de vencimento', 'due', 'due date'],
    description: 'The due date',
  },
  {
    name: 'amount',
    required: true,
    aliases: ['valor', 'saldo', 'valor em aberto', 'open amount'],
    description: 'What is still owed, as a decimal',
  },
  { name: 'currency', required: true, aliases: ['moeda'], description: 'Three-letter currency' },
  {
    name: 'category',
    required: true,
    aliases: ['categoria', 'codigo da categoria', 'category code'],
    description:
      'The code of an active category of the right nature; a title posts only classified',
  },
]

/** The use case's JSON pointer, as the importer's field name. */
function fieldOf(pointer: string | undefined): string | null {
  const parts = pointer?.split('/').filter(Boolean) ?? []
  if (parts[0] === 'installments') return parts[2] === 'dueOn' ? 'dueOn' : 'amount'
  return parts[0] ?? null
}

const issueOf = (error: UseCaseError & { field?: string }): RowIssue =>
  issue(fieldOf(error.field), error.message)

/**
 * A decimal amount as integer minor units of its currency, refusing more places than the
 * currency has: rounding what is owed on the way in would change it.
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

function currencyOk(currency: string): boolean {
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency })
    return /^[A-Z]{3}$/.test(currency)
  } catch {
    return false
  }
}

function uuidIn(record: ImportRecord, field: string, issues: RowIssue[]): string | null {
  const value = valueIn(record, field) ?? ''
  if (UUID.test(value)) return value.toLowerCase()
  issues.push(issue(field, 'must be an id'))
  return null
}

function dateIn(
  record: ImportRecord,
  field: string,
  context: ImportActor,
  issues: RowIssue[],
): string | null {
  const date = dateOf(valueIn(record, field) ?? '', context.dates)
  if (date === null) issues.push(issue(field, 'must be a date'))
  return date
}

/** What is owed, as positive minor units of a currency. */
function moneyIn(record: ImportRecord, context: ImportActor, issues: RowIssue[]) {
  const currency = (valueIn(record, 'currency') ?? '').toUpperCase()
  if (!currencyOk(currency)) {
    issues.push(issue('currency', 'must be a three-letter currency'))
    return null
  }
  const decimal = decimalOf(valueIn(record, 'amount') ?? '', context.numbers)
  const amount = decimal === null ? null : minorUnitsOf(decimal, currency)
  if (amount === null || amount === '0') {
    issues.push(issue('amount', 'must be a positive amount with the currency’s decimals'))
    return null
  }
  return { currency, amount }
}

/**
 * Open receivables or payables at go-live (Phase 64): one title, one installment of what
 * is still owed. A row is drafted and posted through the module's own commands, each keyed
 * by the row, so a resumed import replays them rather than writing twice; a payable above
 * the approval threshold waits for a second person like any other.
 */
export interface TitleImportCommand {
  readonly terms: TermsInput
  readonly category: string
}

export class TitleImporter implements RowImporter<TitleImportCommand> {
  readonly kind: string
  readonly fields = FIELDS

  constructor(
    private readonly direction: TitleDirection,
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
    private readonly rowUnitOfWork: (key: RowKey) => FinancialUnitOfWork,
  ) {
    this.kind = direction === 'receivable' ? 'receivables' : 'payables'
  }

  async session(context: ImportActor): Promise<ImportSession<TitleImportCommand>> {
    return {
      validate: (record) => this.validate(record, context),
      uniqueKey: ({ terms }) => `${terms.partyId}\u0000${terms.documentNumber.trim()}`,
    }
  }

  private validate(
    record: ImportRecord,
    context: ImportActor,
  ): Either<readonly RowIssue[], TitleImportCommand> {
    const issues: RowIssue[] = []
    const partyId = uuidIn(record, 'partyId', issues)
    const category = valueIn(record, 'category')
    if (category === null) issues.push(issue('category', 'must name a category'))
    const issuedOn = dateIn(record, 'issuedOn', context, issues)
    const dueOn = dateIn(record, 'dueOn', context, issues)
    const money = moneyIn(record, context, issues)
    if (issues.length > 0 || !partyId || !issuedOn || !dueOn || !money || category === null)
      return left(issues)
    const terms: TermsInput = {
      partyId,
      documentNumber: valueIn(record, 'documentNumber') ?? '',
      description: valueIn(record, 'description') ?? undefined,
      currency: money.currency,
      categoryId: null,
      issuedOn,
      installments: [{ dueOn, amount: money.amount }],
    }
    const checked = termsOf(terms)
    return checked.isLeft() ? left([issueOf(checked.value)]) : right({ terms, category })
  }

  async write(
    command: TitleImportCommand,
    key: RowKey,
    context: ImportActor,
  ): Promise<Either<readonly RowIssue[], string>> {
    const category = await this.unitOfWork.inTenant(context.tenantId, (scope) =>
      scope.categories.findByCode(command.category),
    )
    if (!category)
      return left([issue('category', `no category has the code "${command.category}"`)])
    const terms = { ...command.terms, categoryId: category.id.toString() }
    const idempotent = (step: string) => ({
      tenantId: context.tenantId,
      actor: context.actor,
      requestId: null,
      idempotencyKey: `import:${key.jobId}:${key.line}:${step}`,
    })
    const draft = new DraftTitleUseCase(this.unitOfWork, this.clock, this.direction)
    const drafted = await draft.execute({ context: idempotent('draft'), terms })
    if (drafted.isLeft()) return left([issueOf(drafted.value)])
    const titleId = drafted.value.id
    const rowUnitOfWork = this.rowUnitOfWork(key)
    const commandContext = { tenantId: context.tenantId, actor: context.actor, requestId: null }
    // A payable the policy holds for approval is asked for it, never posted around it: the
    // row is written once the request is, and a second person decides (ADR 0042).
    if (await this.needsApproval(context.tenantId, titleId)) {
      const requested = await new DecidePayableApprovalUseCase(rowUnitOfWork, this.clock).request(
        commandContext,
        titleId,
      )
      if (requested.isRight()) return right(titleId)
      await this.withdraw(context, titleId)
      return left([issueOf(requested.value)])
    }
    // The post marks the row written in its own transaction: a cancelled row rolls it back.
    const post = new PostTitleUseCase(rowUnitOfWork, this.clock, this.direction)
    const posted = await post.execute({ context: idempotent('post'), titleId })
    if (posted.isRight()) return right(titleId)
    await this.withdraw(context, titleId)
    return left([issueOf(posted.value)])
  }

  private needsApproval(tenantId: string, titleId: string): Promise<boolean> {
    if (this.direction !== 'payable') return Promise.resolve(false)
    return this.unitOfWork.inTenant(tenantId, async (scope) => {
      const title = await scope.titles.findForUpdate(titleId)
      return title !== null && title.status === 'draft' && (await approvalRequired(scope, title))
    })
  }

  /** A draft left behind would be a title nobody asked for: the refused row withdraws it. */
  private async withdraw(context: ImportActor, titleId: string): Promise<void> {
    await new CancelTitleUseCase(this.unitOfWork, this.clock, this.direction).execute({
      context: { tenantId: context.tenantId, actor: context.actor, requestId: null },
      titleId,
      reason: 'the import row was refused when posted',
    })
  }
}
