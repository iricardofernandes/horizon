import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { FiscalCalculations } from './calculations'
import { canonicalJson } from './canonical-json'
import {
  approvedPhase41Input,
  approvedPhase41Source,
  PHASE41_FIXTURE_ID,
  PHASE41_SOURCE_SHA256,
} from './phase41-approved-scenario'
import { FiscalRuleStore } from './rule-store'

const value = (name: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  const found = index < 0 ? undefined : process.argv[index + 1]
  if (!found) throw new Error(`--${name} is required`)
  return found
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  const keyHex = process.env.FISCAL_ARTIFACT_KEY_HEX
  if (!databaseUrl || !keyHex)
    throw new Error('DATABASE_URL and FISCAL_ARTIFACT_KEY_HEX are required')

  const tenantId = value('tenant')
  const documentId = value('document')
  const establishmentId = value('establishment')
  const itemId = value('item')
  const artifactPath = value('artifact')
  const bytes = await readFile(artifactPath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== PHASE41_SOURCE_SHA256)
    throw new Error(`Phase 41 source digest mismatch: ${digest}`)

  const store = new FiscalRuleStore(databaseUrl, 120_000)
  const calculations = new FiscalCalculations(databaseUrl, Buffer.from(keyHex, 'hex'), store)

  try {
    const imported = await store.importSource(
      approvedPhase41Source(tenantId, {
        byteSize: bytes.length,
        storageUri: `file://${artifactPath}`,
      }),
    )
    try {
      await store.reviewPackage({
        tenantId,
        packageId: imported.packageId,
        approved: true,
        reviewedBy: 'workspace-owner',
        reviewedAt: '2026-09-22T13:30:00.000Z',
        interpretation:
          'Workspace owner approved the pinned RTC V0057 model-55 intrastate normal-sale simulation fixture, including 2026 CBS/IBS reference rates, exact arithmetic and half-away-from-zero component rounding. Landing-page V0042 discrepancy was disclosed before approval.',
        fixtureIds: [PHASE41_FIXTURE_ID],
      })
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error
    }
    for (const ruleId of imported.ruleIds)
      await ensureActivation(store, tenantId, ruleId, 'activate', 'Phase 41 approved rollout')

    const calculationInput = approvedPhase41Input({ tenantId, establishmentId, itemId })
    const preview = await calculations.preview(calculationInput)
    if (!preview.supported) throw new Error(`Approved preview failed: ${JSON.stringify(preview)}`)
    const locked = await calculations.validateDocument({
      tenantId,
      documentId,
      actorId: 'workspace-owner',
      calculationInput,
    })
    if (!locked.supported) throw new Error(`Approved lock failed: ${JSON.stringify(locked)}`)
    const replayBeforeRollback = await calculations.replay(tenantId, documentId)
    if (canonicalJson(locked).toString() !== canonicalJson(replayBeforeRollback).toString())
      throw new Error('Phase 41 replay mismatch before rollback')

    for (const ruleId of imported.ruleIds)
      await ensureActivation(
        store,
        tenantId,
        ruleId,
        'deactivate',
        'Phase 41 rollback verification',
      )
    const replayDuringRollback = await calculations.replay(tenantId, documentId)
    if (canonicalJson(locked).toString() !== canonicalJson(replayDuringRollback).toString())
      throw new Error('Phase 41 historical replay changed during rollback')
    for (const ruleId of imported.ruleIds)
      await ensureActivation(store, tenantId, ruleId, 'activate', 'Phase 41 rollback recovery')

    const previewAfterRollback = await calculations.preview(calculationInput)
    if (
      !previewAfterRollback.supported ||
      canonicalJson(preview).toString() !== canonicalJson(previewAfterRollback).toString()
    )
      throw new Error('Phase 41 preview changed after rollback recovery')

    process.stdout.write(
      `${JSON.stringify(
        {
          fixtureId: PHASE41_FIXTURE_ID,
          packageId: imported.packageId,
          packageDigest: imported.packageDigest,
          ruleIds: imported.ruleIds,
          documentId,
          input: calculationInput,
          result: locked,
          replayDigest: replayDuringRollback.resultDigest,
          rollbackVerified: true,
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    await Promise.all([calculations.close(), store.close()])
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phase 41 rollout failed')
  process.exitCode = 1
})

async function ensureActivation(
  store: FiscalRuleStore,
  tenantId: string,
  ruleId: string,
  action: 'activate' | 'deactivate',
  reason: string,
): Promise<void> {
  try {
    await store.activateRule({
      tenantId,
      ruleId,
      action,
      actorId: 'workspace-owner',
      reason,
    })
  } catch (error) {
    if ((error as { code?: string }).code !== '23505') throw error
  }
}
