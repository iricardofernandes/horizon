import type { Attachment, Owner } from '@/domain/attachment'
import { deleted, dueWorkOf, scanFailed } from '@/domain/attachment'
import { type Attachments, eventOf } from './attachments'
import type { Clock, FilesStore, ObjectStore } from './ports'
import { objectKeyOf } from './ports'

export interface WorkOutcome {
  scanned: number
  expired: number
  purged: number
  abandoned: number
  failed: number
}

export interface LifecycleOptions {
  readonly batch: number
  /** How long a claimed row is left to its worker before another may take it. */
  readonly claimMs: number
  readonly scanRetryMs: number
}

export interface ReceivedEvent {
  readonly tenantId: string
  readonly sourceModule: 'parties' | 'identity'
  readonly eventId: string
  readonly eventType: string
}

const EMPTY: WorkOutcome = { scanned: 0, expired: 0, purged: 0, abandoned: 0, failed: 0 }

/**
 * What happens to attachments with nobody asking (Phase 65): slots abandoned, scans
 * retried, retention expired, bytes removed and logged, and owners erased.
 */
export class AttachmentLifecycle {
  constructor(
    private readonly store: FilesStore,
    private readonly attachments: Attachments,
    private readonly objects: ObjectStore,
    private readonly clock: Clock,
    private readonly options: LifecycleOptions,
  ) {}

  /** Works a tenant's due rows until none is left or a pass makes no progress. */
  async runTenant(tenantId: string): Promise<WorkOutcome> {
    const outcome = { ...EMPTY }
    for (let pass = 0; pass < 50; pass += 1) {
      const now = this.clock.now()
      const claimed = await this.store.inTenant(tenantId, (scope) =>
        scope.attachments.claimDue(
          now,
          new Date(now.getTime() + this.options.claimMs),
          this.options.batch,
        ),
      )
      for (const attachment of claimed) await this.work(tenantId, attachment, outcome)
      if (claimed.length < this.options.batch) break
    }
    return outcome
  }

  private async work(tenantId: string, attachment: Attachment, outcome: WorkOutcome) {
    try {
      switch (dueWorkOf(attachment)) {
        case 'abandon':
          await this.end(tenantId, attachment, 'abandoned')
          outcome.abandoned += 1
          return
        case 'scan':
          await this.scan(tenantId, attachment, outcome)
          return
        case 'expire':
          await this.end(tenantId, attachment, 'expired')
          outcome.expired += 1
          return
        case 'purge':
          await this.purge(tenantId, attachment, outcome)
          return
        case 'end-quarantine':
          await this.end(tenantId, attachment, 'quarantined')
          return
        case 'none':
          await this.store.inTenant(tenantId, (scope) =>
            scope.attachments.replace(attachment, { ...attachment, dueAt: null }),
          )
      }
    } catch {
      outcome.failed += 1
    }
  }

  private async scan(tenantId: string, attachment: Attachment, outcome: WorkOutcome) {
    const next = await this.attachments.rescan(tenantId, attachment)
    if (next.status !== 'scanning') {
      outcome.scanned += 1
      return
    }
    outcome.failed += 1
    await this.store.inTenant(tenantId, (scope) =>
      scope.attachments.replace(next, scanFailed(next, this.clock.now(), this.options.scanRetryMs)),
    )
  }

  private async purge(tenantId: string, attachment: Attachment, outcome: WorkOutcome) {
    const next = await this.attachments.purge(
      tenantId,
      attachment,
      attachment.deletionReason ?? 'quarantined',
    )
    if (next.objectKey) outcome.failed += 1
    else outcome.purged += 1
  }

  /** Ends a row with its event; bytes left behind are removed and logged at once. */
  private async end(
    tenantId: string,
    attachment: Attachment,
    reason: 'abandoned' | 'expired' | 'quarantined',
  ) {
    const now = this.clock.now()
    // A slot's bytes may have been stored by an upload that never recorded them.
    if (reason === 'abandoned') await this.objects.remove(objectKeyOf(tenantId, attachment.id))
    const next = deleted(attachment, reason, now)
    const moved = await this.store.inTenant(tenantId, async (scope) => {
      if (!(await scope.attachments.replace(attachment, next))) return false
      await scope.outbox.append(eventOf(next, now))
      return true
    })
    if (moved && next.objectKey) await this.attachments.purge(tenantId, next, reason)
  }

  /**
   * An owner was erased (ADR 0026): its key is destroyed and every file under it ends, in
   * the transaction that records the event, so a redelivery does nothing twice. The bytes,
   * unreadable from now on, are removed by the next pass.
   */
  eraseOwner(event: ReceivedEvent, owner: Owner): Promise<boolean> {
    const now = this.clock.now()
    return this.store.inTenant(event.tenantId, async (scope) => {
      if (!(await scope.inbox.claim(event.sourceModule, event.eventId, event.eventType)))
        return false
      await scope.ownerKeys.shred(owner, now)
      for (const attachment of await scope.attachments.ofOwner(owner)) {
        if (attachment.status === 'deleted') continue
        const next = deleted(attachment, 'erased', now)
        await scope.attachments.replace(attachment, next)
        await scope.outbox.append(eventOf(next, now))
      }
      return true
    })
  }
}
