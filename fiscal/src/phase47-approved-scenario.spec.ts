import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NFSE_SCHEMA_DIGEST } from './nfse/schema'
import {
  approvedPhase47IbsCbsSource,
  approvedPhase47IssSource,
  PHASE47_SOURCE_MANIFEST_DIGEST,
  phase47RegistryVersion,
} from './phase47-approved-scenario'

const root = join(__dirname, '..', '..')

describe('Phase 47 approved scenario', () => {
  it('pins the source manifest, schema and reference extract it names', async () => {
    const manifestBytes = await readFile(
      join(root, 'fiscal', 'fixtures', 'official', 'phase47-source-manifest.json'),
    )
    expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe(
      PHASE47_SOURCE_MANIFEST_DIGEST,
    )
    const manifest = JSON.parse(manifestBytes.toString()) as {
      artifacts: Array<{ storagePath: string; sha256: string }>
    }
    for (const artifact of manifest.artifacts.filter((entry) =>
      entry.storagePath.startsWith('fiscal/'),
    )) {
      const bytes = await readFile(join(root, artifact.storagePath))
      expect(createHash('sha256').update(bytes).digest('hex'), artifact.storagePath).toBe(
        artifact.sha256,
      )
    }
    expect(manifest.artifacts.map((entry) => entry.sha256)).toContain(NFSE_SCHEMA_DIGEST)
    const registry = phase47RegistryVersion()
    expect(manifest.artifacts.map((entry) => entry.sha256)).toContain(registry.sourceDigest)
  })

  it('selects ISS and IBS/CBS rules by competence for one municipality and service', () => {
    const tenantId = '0199a5f0-0000-7000-8000-000000000001'
    const iss = approvedPhase47IssSource(tenantId, '3550308')
    expect(iss.rules).toHaveLength(1)
    expect(iss.rules[0]).toMatchObject({
      code: 'ISS',
      group: 'legacy',
      dateBasis: 'competence_date',
      operation: 'rtc-v0057-nfse-service-3550308',
      classification: { kind: 'service', code: '010101' },
    })
    const ibsCbs = approvedPhase47IbsCbsSource(tenantId, '3550308')
    expect(ibsCbs.rules.map((rule) => rule.code)).toEqual(['CBS', 'IBS_UF', 'IBS_MUN'])
    expect(() => approvedPhase47IssSource(tenantId, '3509502')).toThrow(/ISS parameter/)
  })
})
