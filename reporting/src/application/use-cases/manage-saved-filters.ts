import { uuidv7 } from 'uuidv7'
import { type Either, left, right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { type ReportFilter, type ReportName, reportFilterOf } from '@/domain/reports'
import type { Clock } from '../ports/journal-store'
import type { ReportingCommands, SavedFilter } from '../ports/report-store'
import { audit, type CommandContext, type IdempotentContext, once } from './commands'

export interface FilterInput {
  readonly currency?: string | null | undefined
  readonly from?: string | null | undefined
  readonly to?: string | null | undefined
}

/** What the caller may do with a filter: save their own, and share with the workspace. */
export interface FilterPermissions {
  readonly share: boolean
}

type Failure = InvalidInputError | ResourceNotFoundError | ConflictError

function nameOf(name: string): Either<InvalidInputError, string> {
  const trimmed = name.trim()
  return trimmed.length >= 1 && trimmed.length <= 80
    ? right(trimmed)
    : left(new InvalidInputError('name', 'must have 1 to 80 characters'))
}

/** Whether the caller may change a filter: its owner, or someone who may share. */
function mayChange(filter: SavedFilter, actor: string, permissions: FilterPermissions) {
  return filter.ownerId === actor || (filter.shared && permissions.share)
}

const MISSING = () => new ResourceNotFoundError('Saved filter')

/**
 * A person's saved filters for a report, private or shared with the workspace (Phase 62).
 * They are presentation state, not business facts, but they are still audited.
 */
export class ManageSavedFiltersUseCase {
  constructor(
    private readonly commands: ReportingCommands,
    private readonly clock: Clock,
  ) {}

  create(
    context: IdempotentContext,
    permissions: FilterPermissions,
    input: {
      readonly report: ReportName
      readonly name: string
      readonly filter: FilterInput
      readonly shared: boolean
    },
  ): Promise<Either<Failure, SavedFilter>> {
    return once(this.commands, context, 'saved-filter.create', input, async (scope) => {
      if (input.shared && !permissions.share)
        return left(new InvalidInputError('shared', 'only an administrator shares a filter'))
      const name = nameOf(input.name)
      if (name.isLeft()) return left(name.value)
      const filter = reportFilterOf(input.filter)
      if (filter.isLeft()) return left(filter.value)
      const now = this.clock.now()
      const saved: SavedFilter = {
        filterId: uuidv7(),
        report: input.report,
        name: name.value,
        filter: filter.value,
        ownerId: context.actor,
        shared: input.shared,
        createdAt: now,
        updatedAt: now,
      }
      await scope.filters.insert(saved)
      await audit(scope, context, {
        action: 'saved-filter.created',
        subjectType: 'saved-filter',
        subjectId: saved.filterId,
        occurredAt: now,
        details: { report: saved.report, shared: saved.shared },
      })
      return right(saved)
    })
  }

  update(
    context: CommandContext,
    permissions: FilterPermissions,
    filterId: string,
    input: {
      readonly name?: string | undefined
      readonly filter?: FilterInput | undefined
      readonly shared?: boolean | undefined
    },
  ): Promise<Either<Failure, SavedFilter>> {
    return this.commands.inTenant(
      context.tenantId,
      async (scope): Promise<Either<Failure, SavedFilter>> => {
        const current = await scope.filters.find(filterId)
        if (!current || !mayChange(current, context.actor, permissions)) return left(MISSING())
        if (input.shared !== undefined && input.shared !== current.shared && !permissions.share)
          return left(new InvalidInputError('shared', 'only an administrator shares a filter'))
        const name: Either<InvalidInputError, string> =
          input.name === undefined ? right(current.name) : nameOf(input.name)
        if (name.isLeft()) return left(name.value)
        const filter: Either<InvalidInputError, ReportFilter> =
          input.filter === undefined ? right(current.filter) : reportFilterOf(input.filter)
        if (filter.isLeft()) return left(filter.value)
        const now = this.clock.now()
        const next: SavedFilter = {
          ...current,
          name: name.value,
          filter: filter.value,
          shared: input.shared ?? current.shared,
          updatedAt: now,
        }
        await scope.filters.update(next)
        await audit(scope, context, {
          action: 'saved-filter.changed',
          subjectType: 'saved-filter',
          subjectId: filterId,
          occurredAt: now,
          details: { fields: Object.keys(input).sort() },
        })
        return right(next)
      },
    )
  }

  remove(
    context: CommandContext,
    permissions: FilterPermissions,
    filterId: string,
  ): Promise<Either<Failure, { readonly filterId: string }>> {
    return this.commands.inTenant(
      context.tenantId,
      async (scope): Promise<Either<Failure, { readonly filterId: string }>> => {
        const current = await scope.filters.find(filterId)
        if (!current || !mayChange(current, context.actor, permissions)) return left(MISSING())
        await scope.filters.remove(filterId)
        await audit(scope, context, {
          action: 'saved-filter.removed',
          subjectType: 'saved-filter',
          subjectId: filterId,
          occurredAt: this.clock.now(),
          details: { report: current.report },
        })
        return right({ filterId })
      },
    )
  }
}
