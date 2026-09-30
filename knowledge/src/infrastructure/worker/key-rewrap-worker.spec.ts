import { describe, expect, it } from 'vitest'
import { KeyRewrapWorker, type RewrapStore } from './key-rewrap-worker'

/** Keys per tenant, each either on the current master key or not. */
function store(keys: Record<string, string[]>): RewrapStore & { keys: Record<string, string[]> } {
  return {
    keys,
    async tenantsOnOldMasterKeys(currentId) {
      return Object.entries(keys)
        .map(([tenantId, ids]) => ({ tenantId, keys: ids.filter((id) => id !== currentId).length }))
        .filter((tenant) => tenant.keys > 0)
    },
    async rewrapKeys(tenantId, currentId, rewrap, limit) {
      const ids = keys[tenantId] ?? []
      let moved = 0
      for (const [index, id] of ids.entries()) {
        if (id === currentId || moved === limit) continue
        rewrap(`a${index}`, 'wrapped')
        ids[index] = currentId
        moved++
      }
      return moved
    },
  }
}

const sealer = { masterKeyId: 'new', rewrap: () => 'rewrapped' }

describe('the rewrap worker (Phase 81)', () => {
  it('moves every key of every tenant, in batches, and reports none left', async () => {
    const keys = store({ t1: ['old', 'old', 'old', 'old', 'old'], t2: ['new', 'old'] })
    const worker = new KeyRewrapWorker(keys, sealer, 60_000, 2)
    expect(await worker.pass()).toBe(0)
    expect(keys.keys).toEqual({ t1: ['new', 'new', 'new', 'new', 'new'], t2: ['new', 'new'] })
  })

  it('reports what is left when a key cannot be opened, and keeps running', async () => {
    const failing = {
      ...store({ t1: ['old'] }),
      async rewrapKeys(): Promise<number> {
        throw new Error('Wrapped under a master key this ring does not hold')
      },
    }
    expect(await new KeyRewrapWorker(failing, sealer, 60_000).pass()).toBeNull()
  })
})
