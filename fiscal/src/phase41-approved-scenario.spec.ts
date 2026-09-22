import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { calculateFiscal } from './calculation'
import { canonicalJson } from './canonical-json'
import { approvedPhase41ResolvedRules, PHASE41_SOURCE_SHA256 } from './phase41-approved-scenario'

describe('Phase 41 approved RTC V0057 golden fixture', () => {
  it('reproduces the reviewed digests and amounts', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL('../fixtures/rtc-v0057-model55-normal-sale-sp-2026-01.json', import.meta.url),
        'utf8',
      ),
    )
    const rules = approvedPhase41ResolvedRules({
      packageId: fixture.packageId,
      cbsRuleId: fixture.ruleIds.CBS,
      ibsUfRuleId: fixture.ruleIds.IBS_UF,
      ibsMunRuleId: fixture.ruleIds.IBS_MUN,
    })

    expect(fixture.source.sha256).toBe(PHASE41_SOURCE_SHA256)
    const result = calculateFiscal(fixture.input, rules)
    expect(canonicalJson(result).toString()).toBe(canonicalJson(fixture.expectedResult).toString())
  })
})
