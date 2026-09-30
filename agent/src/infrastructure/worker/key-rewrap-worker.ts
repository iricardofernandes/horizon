import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { metrics } from '@opentelemetry/api'

export interface RewrapStore {
  tenantsOnOldMasterKeys(currentId: string): Promise<{ tenantId: string; keys: number }[]>
  rewrapKeys(
    tenantId: string,
    currentId: string,
    rewrap: (userId: string, wrappedKey: string) => string,
    limit: number,
  ): Promise<number>
}

export interface Rewrapper {
  readonly masterKeyId: string
  rewrap(wrappedKey: string, tenantId: string, userId: string): string
}

const onOldMasterKeys = metrics
  .getMeter('agent.keys')
  .createGauge('assistant_keys_on_old_master_keys', {
    description: 'Person keys not yet wrapped under the current master key',
  })

/**
 * Master key rotation (Phase 81): every person key still wrapped under a retired master key
 * is rewrapped under the current one, a batch at a time. It says when none is left, which is
 * when the retired key can be removed from `ASSISTANT_PREVIOUS_MASTER_KEYS`.
 */
export class KeyRewrapWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeyRewrapWorker.name)
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private lastRemaining: number | null = null

  constructor(
    private readonly store: RewrapStore,
    private readonly sealer: Rewrapper,
    private readonly intervalMs: number,
    private readonly batch = 200,
  ) {}

  onModuleInit(): void {
    void this.pass()
    this.timer = setInterval(() => void this.pass(), this.intervalMs)
    this.timer.unref()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** One pass over every tenant; the keys left on old master keys afterwards. */
  async pass(): Promise<number | null> {
    if (this.running) return null
    this.running = true
    try {
      const currentId = this.sealer.masterKeyId
      for (const { tenantId } of await this.store.tenantsOnOldMasterKeys(currentId))
        while (
          (await this.store.rewrapKeys(
            tenantId,
            currentId,
            (userId, wrapped) => this.sealer.rewrap(wrapped, tenantId, userId),
            this.batch,
          )) === this.batch
        );
      const remaining = (await this.store.tenantsOnOldMasterKeys(currentId)).reduce(
        (sum, tenant) => sum + tenant.keys,
        0,
      )
      onOldMasterKeys.record(remaining)
      if (remaining === 0 && this.lastRemaining !== 0)
        this.logger.log('every person key is wrapped under the current master key')
      this.lastRemaining = remaining
      return remaining
    } catch (error) {
      this.logger.warn(`rewrap failed (${error instanceof Error ? error.name : 'Error'})`)
      return null
    } finally {
      this.running = false
    }
  }
}
