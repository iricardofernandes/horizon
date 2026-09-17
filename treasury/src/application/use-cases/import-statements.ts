import { createHash } from 'node:crypto'
import { left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { fingerprintsOf, type StatementLine } from '@/domain/entities/statement-line'
import { TreasuryEvent } from '@/domain/events/treasury-events'
import type { Clock } from '../ports/clock'
import type { StatementAdapter, StatementFormat } from '../ports/statement-adapter'
import type { TreasuryUnitOfWork } from '../ports/unit-of-work'
import { audit, type IdempotentContext, type Outcome, once } from './commands'

export interface ImportOutcome {
  readonly importId: string
  readonly imported: number
  readonly duplicates: number
  readonly alreadyImported: boolean
}

/**
 * Store what the bank asserted, once. The file is identified by its hash and every line by
 * its fingerprint, so importing the same file again — or a file that overlaps an earlier
 * one — stores nothing it already has and says so (ADR 0046).
 */
export class ImportStatementUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
    private readonly adapters: Readonly<Record<StatementFormat, StatementAdapter>>,
  ) {}

  async execute(request: {
    context: IdempotentContext
    accountId: string
    format: StatementFormat
    fileName: string
    content: string
  }): Outcome<ImportOutcome> {
    const parsed = this.adapters[request.format].parse(request.content)
    if (parsed.isLeft()) return left(parsed.value)
    const statement = parsed.value
    if (statement.lines.length === 0)
      return left(new InvalidInputError('/content', 'the statement has no lines'))
    const fileHash = createHash('sha256').update(request.content).digest('hex')
    const { context } = request
    const fingerprint = { accountId: request.accountId, format: request.format, fileHash }
    return once(this.unitOfWork, context, 'statement.import', fingerprint, async (scope) => {
      const [account] = await scope.accounts.findForUpdate([request.accountId])
      if (!account) return left(new ResourceNotFoundError('account was not found'))
      if (statement.currency && statement.currency !== account.currency.value)
        return left(
          new ConflictError(
            `the statement is in ${statement.currency}; the account holds ${account.currency.value}`,
          ),
        )
      await scope.lockAccount(request.accountId)
      const previous = await scope.statements.findImportByHash(request.accountId, fileHash)
      if (previous)
        return right({
          importId: previous.id,
          imported: 0,
          duplicates: statement.lines.length,
          alreadyImported: true,
        })
      const fingerprints = fingerprintsOf(request.accountId, statement.lines)
      const known = await scope.statements.knownFingerprints(request.accountId, fingerprints)
      const importId = new UniqueEntityID().toString()
      const lines: StatementLine[] = statement.lines.flatMap((line, index) => {
        const lineFingerprint = fingerprints[index] ?? ''
        if (known.has(lineFingerprint)) return []
        return [
          {
            ...line,
            id: new UniqueEntityID().toString(),
            tenantId: context.tenantId,
            accountId: request.accountId,
            importId,
            fingerprint: lineFingerprint,
            currency: account.currency.value,
            description: line.description.slice(0, 500),
          },
        ]
      })
      const dates = statement.lines.map((line) => line.postedOn).sort()
      const now = this.clock.now()
      const duplicates = statement.lines.length - lines.length
      const statementImport = {
        id: importId,
        accountId: request.accountId,
        format: request.format,
        fileName: request.fileName,
        fileHash,
        lineCount: lines.length,
        duplicateCount: duplicates,
        periodStart: dates[0] ?? null,
        periodEnd: dates.at(-1) ?? null,
        closingBalance: statement.closingBalance,
        importedBy: context.actor,
        importedAt: now,
      }
      const event = new TreasuryEvent(
        'treasury.statement.imported',
        new UniqueEntityID(importId),
        context.tenantId,
        now,
        {
          importId,
          accountId: request.accountId,
          format: request.format,
          lineCount: lines.length,
          duplicateCount: duplicates,
          periodStart: statementImport.periodStart,
          periodEnd: statementImport.periodEnd,
          importedAt: now.toISOString(),
        },
      )
      await scope.statements.append(statementImport, lines, event)
      await audit(scope, context, {
        action: 'statement.imported',
        subjectType: 'statement-import',
        subjectId: importId,
        occurredAt: now,
        details: { accountId: request.accountId, fileHash, imported: lines.length, duplicates },
      })
      return right({ importId, imported: lines.length, duplicates, alreadyImported: false })
    })
  }
}
