import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { z } from 'zod'
import type { NcmTable } from '@/application/suggestion-ports'
import type { NcmTableLoader } from '@/application/suggestions'

const tableSchema = z.object({
  act: z.string().min(1),
  codes: z.array(z.tuple([z.string().regex(/^\d{8}$/), z.string().min(1)])).min(1),
})

/** The official NCM table as a file: gzipped JSON, `{ act, codes: [[code, text], …] }`. */
export async function readNcmTable(path: string): Promise<NcmTable> {
  return tableSchema.parse(JSON.parse(gunzipSync(await readFile(path)).toString('utf8')))
}

/**
 * Loads the official NCM table in the background when suggestions are on (Phase 77): once
 * per act and embedder, so a restart costs nothing, and a stack serves while it loads. A
 * failed load — the model still starting, say — is tried again until it succeeds.
 */
export class NcmTableWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NcmTableWorker.name)
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  running: Promise<boolean> | undefined

  constructor(
    private readonly loader: NcmTableLoader,
    private readonly path: string,
    private readonly retryMs = 60_000,
  ) {}

  onModuleInit(): void {
    this.running = this.attempt()
  }

  onModuleDestroy(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  /** One try: true once the table is current. */
  async attempt(): Promise<boolean> {
    try {
      const outcome = await this.loader.load(await readNcmTable(this.path))
      this.logger.log(`official NCM table ${outcome}`)
      return true
    } catch (error) {
      this.logger.warn(
        `official NCM table not loaded yet (${error instanceof Error ? error.name : 'Error'}); trying again`,
      )
      if (!this.stopped) {
        this.timer = setTimeout(() => {
          this.running = this.attempt()
        }, this.retryMs)
        this.timer.unref()
      }
      return false
    }
  }
}
