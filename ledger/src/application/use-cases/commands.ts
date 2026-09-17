import { createHash } from 'node:crypto'
import { canonicalJson } from '@/core/audit/canonical-json'
import type { Either } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { AuditRecord, LedgerScope, LedgerUnitOfWork } from '../ports/unit-of-work'

/** Who asked, and how to find the request again in logs and traces. */
export interface CommandContext {
  readonly tenantId: string
  readonly actor: string
  readonly requestId: string | null
}

export interface IdempotentContext extends CommandContext {
  readonly idempotencyKey: string
}

export type Failure = InvalidInputError | ConflictError | ResourceNotFoundError
export type Outcome<T> = Promise<Either<Failure, T>>

/** Run `work` once per idempotency key, remembering the command and what it asked for. */
export function once<T>(
  unitOfWork: LedgerUnitOfWork,
  context: IdempotentContext,
  command: string,
  request: unknown,
  work: (scope: LedgerScope) => Outcome<T>,
): Outcome<T> {
  return unitOfWork.once(
    context.tenantId,
    {
      idempotencyKey: context.idempotencyKey,
      command,
      fingerprint: createHash('sha256').update(canonicalJson({ command, request })).digest('hex'),
    },
    work,
  )
}

export function audit(
  scope: LedgerScope,
  context: CommandContext,
  record: Pick<AuditRecord, 'action' | 'subjectType' | 'subjectId' | 'occurredAt' | 'details'>,
) {
  return scope.audit.append({ ...record, actor: context.actor, requestId: context.requestId })
}
