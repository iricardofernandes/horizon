import postgres from 'postgres'
import { DueReminderTenants } from '@/application/ports/due-reminder-tenants'

/**
 * Asks, as `horizon_relay`, which workspaces have a reminder to send (Phase 57). That role
 * reads four columns of `tasks` and no text; the reminders are then claimed per tenant by
 * the application role, under RLS.
 */
export class RelayDueReminderTenants extends DueReminderTenants {
  readonly #client: ReturnType<typeof postgres>

  constructor(url: string) {
    super()
    this.#client = postgres(url, {
      max: 1,
      connect_timeout: 5,
      connection: { statement_timeout: 5000 },
    })
  }

  async find(now: Date, limit: number): Promise<readonly string[]> {
    const rows = await this.#client<{ tenant_id: string }[]>`
      select distinct tenant_id from tasks
      where status = 'open' and reminded_at is null and remind_at is not null and remind_at <= ${now}
      limit ${limit}`
    return rows.map((row) => row.tenant_id)
  }

  async close(): Promise<void> {
    await this.#client.end({ timeout: 5 })
  }
}
