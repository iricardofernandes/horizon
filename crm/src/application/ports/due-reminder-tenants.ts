/**
 * Which workspaces have a task reminder to send (Phase 57). Only this question crosses
 * tenants: the reminders themselves are claimed and sent inside each tenant's own
 * transaction, under its row-level security.
 */
export abstract class DueReminderTenants {
  abstract find(now: Date, limit: number): Promise<readonly string[]>
}
