import { describe, expect, it, vi } from 'vitest'
import type { NcmTableLoader } from '@/application/suggestions'
import { NcmTableWorker } from './ncm-table-worker'

describe('the NCM table worker (Phase 77)', () => {
  it('tries again after a failed load, until the table is current', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const loader = {
        load: async () => {
          calls += 1
          if (calls === 1) throw new TypeError('fetch failed')
          return 'loaded' as const
        },
      } as unknown as NcmTableLoader
      const worker = new NcmTableWorker(
        loader,
        `${__dirname}/../../../data/ncm-table.json.gz`,
        1000,
      )
      expect(await worker.attempt()).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await worker.running).toBe(true)
      expect(calls).toBe(2)
      worker.onModuleDestroy()
    } finally {
      vi.useRealTimers()
    }
  })
})
