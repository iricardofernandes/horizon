import { createHash } from 'node:crypto'
import { canonicalJson } from '@/core/audit/canonical-json'
import type { Either } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { AuditRecord, SalesScope, SalesUnitOfWork } from '../ports/unit-of-work'

/** Who asked, and how to find the request again in logs and traces. */
export interface CommandContext {
  readonly tenantId: string
  readonly actor: string
  readonly requestId: string | null
  /** The key the act went through, when it did (ADR 0066); recorded in the audit entry. */
  readonly via?: string | null
}

export interface IdempotentContext extends CommandContext {
  readonly idempotencyKey: string
}

export type Failure = InvalidInputError | ConflictError | ResourceNotFoundError
export type Outcome<T> = Promise<Either<Failure, T>>

/**
 * Run `work` once per idempotency key, remembering the command and what it asked for.
 *
 * What it asked for excludes who asked and how the request was traced: a retry through the
 * gateway carries a new request id, and it is still the same request.
 */
export function once<T>(
  unitOfWork: SalesUnitOfWork,
  context: IdempotentContext,
  command: string,
  request: unknown,
  work: (scope: SalesScope) => Outcome<T>,
): Outcome<T> {
  return unitOfWork.once(
    context.tenantId,
    {
      idempotencyKey: context.idempotencyKey,
      command,
      fingerprint: createHash('sha256')
        .update(canonicalJson({ command, request: withoutContext(request) }))
        .digest('hex'),
    },
    work,
  )
}

export function audit(
  scope: SalesScope,
  context: CommandContext,
  record: Pick<AuditRecord, 'action' | 'subjectType' | 'subjectId' | 'occurredAt' | 'details'>,
) {
  return scope.audit.append({
    ...record,
    // A key's act names the person and the key (ADR 0066).
    details: context.via ? { ...record.details, via: context.via } : record.details,
    actor: context.actor,
    requestId: context.requestId,
  })
}

function withoutContext(request: unknown): unknown {
  if (!request || typeof request !== 'object' || !('context' in request)) return request
  const { context: _context, ...rest } = request as Record<string, unknown>
  return rest
}
