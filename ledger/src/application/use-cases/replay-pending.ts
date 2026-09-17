import { right } from '@/core/either'
import type { Clock } from '../ports/clock'
import type { LedgerUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext, type Outcome } from './commands'
import { PostFactUseCase } from './post-facts'

const BATCH = 500

/**
 * Try the facts that could not be posted again.
 *
 * A pending fact is one the workspace can act on: map the missing account, reopen the
 * month, and replay. Nothing is lost in the meantime, and nothing is posted twice — a fact
 * that already succeeded is not pending any more.
 */
export class ReplayPendingFactsUseCase {
  constructor(
    private readonly unitOfWork: LedgerUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
  }): Outcome<{ attempted: number; posted: number; stillPending: number }> {
    const { context } = request
    const posting = new PostFactUseCase(this.clock)
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const pending = await scope.facts.pending(BATCH)
      let posted = 0
      for (const record of pending) {
        const outcome = await posting.executeInScope(scope, record.fact)
        if (outcome.status === 'posted') posted += 1
      }
      if (posted > 0)
        await audit(scope, context, {
          action: 'postings.replayed',
          subjectType: 'mapping',
          subjectId: context.tenantId,
          occurredAt: this.clock.now(),
          details: { attempted: pending.length, posted },
        })
      return right({
        attempted: pending.length,
        posted,
        stillPending: pending.length - posted,
      })
    })
  }
}
