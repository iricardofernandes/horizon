import { Logger } from '@nestjs/common'
import { metrics } from '@opentelemetry/api'
import type { ReminderRun } from '@/application/use-cases/fire-due-reminders'

const meter = metrics.getMeter('crm.reminders')
const sent = meter.createCounter('crm_task_reminders_sent_total')
const failures = meter.createCounter('crm_task_reminder_runs_failed_total')

export interface ReminderWorkerOptions {
  readonly run: () => Promise<ReminderRun>
  readonly intervalMs: number
  readonly close?: () => Promise<void>
}

/**
 * Sends due task reminders on a timer, in the CRM process (Phase 57). Several instances
 * may run at once: each reminder is claimed by one of them and sent once.
 */
export class ReminderWorker {
  private readonly logger = new Logger(ReminderWorker.name)
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private stopped = false
  private failed = 0

  constructor(private readonly options: ReminderWorkerOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1000)
      throw new Error('Reminder poll interval must be at least 1000ms')
  }

  onModuleInit(): void {
    this.schedule(this.options.intervalMs)
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.pending = this.poll()
    }, delay)
  }

  private async poll(): Promise<void> {
    try {
      const run = await this.options.run()
      if (run.sent) sent.add(run.sent)
      this.failed = 0
    } catch (error) {
      this.failed += 1
      failures.add(1)
      this.logger.error(
        `Reminder run failed (${error instanceof Error ? error.name : 'unknown error'}); due reminders will be retried`,
      )
    }
    const base = this.options.intervalMs
    this.schedule(
      this.failed === 0 ? base : Math.min(base * 2 ** Math.min(this.failed, 4), 300_000),
    )
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.pending
    await this.options.close?.()
  }
}
