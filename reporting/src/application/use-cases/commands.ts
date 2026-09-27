import { createHash } from 'node:crypto'
import { canonicalJson } from '@/core/audit/canonical-json'
import type { Either } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type { AuditRecord, CommandScope, ReportingCommands } from '../ports/report-store'

/** Who asked, and how to find the request again in logs and traces. */
export interface CommandContext {
  readonly tenantId: string
  readonly actor: string
  readonly requestId: string | null
}

export interface IdempotentContext extends CommandContext {
  readonly idempotencyKey: string
}

/** Run `work` once per idempotency key, remembering the command and what it asked for. */
export function once<E, T>(
  commands: ReportingCommands,
  context: IdempotentContext,
  command: string,
  request: unknown,
  work: (scope: CommandScope) => Promise<Either<E, T>>,
): Promise<Either<E | ConflictError, T>> {
  return commands.once(
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
  scope: CommandScope,
  context: CommandContext,
  record: Pick<AuditRecord, 'action' | 'subjectType' | 'subjectId' | 'occurredAt' | 'details'>,
) {
  return scope.audit.append({ ...record, actor: context.actor, requestId: context.requestId })
}
