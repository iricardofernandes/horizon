import { createHash } from 'node:crypto'
import { canonicalJson } from '@/core/audit/canonical-json'
import type { Either } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { NotAllowedError } from '@/core/errors/errors/not-allowed-error'
import type { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { SegregationOfDutiesError } from '@/core/errors/errors/segregation-of-duties-error'
import type { AuditRecord, InventoryScope, InventoryUnitOfWork } from '../ports/unit-of-work'

/** Who asked, and how to find the request again in logs and traces. */
export interface CommandContext {
  readonly tenantId: string
  readonly actor: string
  readonly requestId: string | null
  /** The key the act went through, when it did (ADR 0066); recorded in the audit entry. */
  readonly via?: string | null
  /**
   * The approvals the person holds through their own role (ADR 0062). Anything else they
   * decide takes an active delegation.
   */
  readonly approvals?: readonly string[]
}

export interface IdempotentContext extends CommandContext {
  readonly idempotencyKey: string
}

export type Failure =
  | InvalidInputError
  | ConflictError
  | ResourceNotFoundError
  | NotAllowedError
  | SegregationOfDutiesError
export type Outcome<T> = Promise<Either<Failure, T>>

/** Run `work` once per idempotency key, remembering the command and what it asked for. */
export function once<T>(
  unitOfWork: InventoryUnitOfWork,
  context: IdempotentContext,
  command: string,
  request: unknown,
  work: (scope: InventoryScope) => Outcome<T>,
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
  scope: InventoryScope,
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
