import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dimensionKind, oracleReportSchema, startLockReplaySampler } from './tax-metrics'

/** The oracle's record lives in the repository's docs, absent when Fiscal is checked out alone. */
const ORACLE_REPORT = join(
  __dirname,
  '..',
  '..',
  'docs',
  'drills',
  '2026-09-30-phase84-oracle-2026.json',
)

describe('Phase O service levels (Phase 89)', () => {
  it('labels a missing dimension by its kind, never by its value', () => {
    expect(dimensionKind('018f5d4e-1000-7000-8000-0000000000a1')).toBe('line')
    expect(dimensionKind('ncm:85094010')).toBe('classification-ncm')
    expect(dimensionKind('class_trib:000001')).toBe('classification-class_trib')
    expect(dimensionKind('legacy:ICMS')).toBe('component')
    expect(dimensionKind('issuerRegime')).toBe('issuerRegime')
    expect(dimensionKind('IPI')).toBe('tax')
    expect(dimensionKind('Rua A, 42')).toBe('other')
    expect(dimensionKind(undefined)).toBe('none')
  })

  it.skipIf(!existsSync(ORACLE_REPORT))('reads the report make tax-oracle writes', async () => {
    const report = JSON.parse(await readFile(ORACLE_REPORT, 'utf8'))
    expect(oracleReportSchema.parse(report)).toMatchObject({
      kind: 'oracle-2026',
      differ: 0,
      refused: 0,
    })
  })

  it('replays each served workspace’s recent locks, and keeps going past a failure', async () => {
    const replayed: string[] = []
    const stop = startLockReplaySampler({
      tenantIds: ['a', 'b'],
      recent: async (tenantId) => (tenantId === 'a' ? ['a1', 'a2'] : ['b1']),
      replay: async (tenantId, documentId) => {
        replayed.push(`${tenantId}:${documentId}`)
        if (documentId === 'a1') throw new Error('Fiscal calculation replay integrity failure')
      },
      intervalMilliseconds: 10,
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    stop()
    expect(replayed.slice(0, 3)).toEqual(['a:a1', 'a:a2', 'b:b1'])
  })
})
