import { uuidv7 } from 'uuidv7'
import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ForbiddenError } from '@/core/errors/errors/forbidden-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { type SavedView, type ViewInput, viewProblem, visibleTo } from '@/domain/views'
import type { Clock } from './ports/journal-store'

/** Where saved views are kept, per tenant. */
export abstract class ViewStore {
  abstract list(tenantId: string, userId: string, screen: string | null): Promise<SavedView[]>
  abstract find(tenantId: string, viewId: string): Promise<SavedView | null>
  abstract insert(tenantId: string, view: SavedView): Promise<void>
  abstract update(tenantId: string, view: SavedView): Promise<void>
  abstract remove(tenantId: string, viewId: string): Promise<void>
}

type Failure = InvalidInputError | ResourceNotFoundError | ForbiddenError | ConflictError

const notFound = () => new ResourceNotFoundError('Saved view was not found')

/**
 * Saved views (Phase 66). Everyone sees their own and the shared ones; only the owner
 * changes, shares or deletes a view. Another person's private view does not exist for them.
 */
export class ManageViewsUseCase {
  constructor(
    private readonly store: ViewStore,
    private readonly clock: Clock,
  ) {}

  list(tenantId: string, userId: string, screen: string | null) {
    return this.store.list(tenantId, userId, screen)
  }

  async create(
    tenantId: string,
    userId: string,
    input: ViewInput,
  ): Promise<Either<Failure, SavedView>> {
    const problem = viewProblem(input)
    if (problem) return left(new InvalidInputError('view', problem))
    const taken = (await this.store.list(tenantId, userId, input.screen)).some(
      (view) => view.ownerId === userId && view.name === input.name.trim(),
    )
    if (taken) return left(new ConflictError('you already have a view with this name here'))
    const now = this.clock.now()
    const view: SavedView = {
      ...input,
      name: input.name.trim(),
      viewId: uuidv7(),
      ownerId: userId,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.insert(tenantId, view)
    return right(view)
  }

  async update(
    tenantId: string,
    userId: string,
    viewId: string,
    changes: Partial<Omit<ViewInput, 'screen'>>,
  ): Promise<Either<Failure, SavedView>> {
    const current = await this.owned(tenantId, userId, viewId)
    if (current.isLeft()) return current
    const next: SavedView = {
      ...current.value,
      ...changes,
      name: (changes.name ?? current.value.name).trim(),
      updatedAt: this.clock.now(),
    }
    const problem = viewProblem(next)
    if (problem) return left(new InvalidInputError('view', problem))
    await this.store.update(tenantId, next)
    return right(next)
  }

  async remove(
    tenantId: string,
    userId: string,
    viewId: string,
  ): Promise<Either<Failure, { removed: true }>> {
    const current = await this.owned(tenantId, userId, viewId)
    if (current.isLeft()) return left(current.value)
    await this.store.remove(tenantId, viewId)
    return right({ removed: true })
  }

  /** A shared view of someone else is found, but is not theirs to change. */
  private async owned(
    tenantId: string,
    userId: string,
    viewId: string,
  ): Promise<Either<Failure, SavedView>> {
    const view = await this.store.find(tenantId, viewId)
    if (!view || !visibleTo(view, userId)) return left(notFound())
    if (view.ownerId !== userId)
      return left(new ForbiddenError('only its owner changes a saved view'))
    return right(view)
  }
}
