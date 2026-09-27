import type { Clock } from '../ports/clock'
import type { DueReminderTenants } from '../ports/due-reminder-tenants'
import type { CrmUnitOfWork } from '../ports/unit-of-work'

export interface ReminderRun {
  readonly tenants: number
  readonly sent: number
}

/**
 * Send every task reminder that came due (Phase 57).
 *
 * Each tenant's due reminders are claimed in that tenant's transaction and marked as sent
 * together with their `crm.task.due` outbox row. A reminder another sender already holds
 * is skipped, and one already sent no longer matches, so a restart or a second scheduler
 * never sends it twice.
 */
export class FireDueRemindersUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly tenants: DueReminderTenants,
    private readonly clock: Clock,
    private readonly batchSize = 100,
    private readonly tenantsPerRun = 50,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
      throw new Error('Invalid reminder batch size')
  }

  async execute(): Promise<ReminderRun> {
    const now = this.clock.now()
    const tenants = await this.tenants.find(now, this.tenantsPerRun)
    let sent = 0
    for (const tenantId of tenants)
      sent += await this.unitOfWork.inTenant(tenantId, async (scope) => {
        let fired = 0
        for (const task of await scope.tasks.claimDueReminders(now, this.batchSize)) {
          if (task.sendReminder(now).isLeft()) continue
          await scope.tasks.save(task)
          fired += 1
        }
        return fired
      })
    return { tenants: tenants.length, sent }
  }
}
