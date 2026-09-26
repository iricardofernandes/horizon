import { createHash } from 'node:crypto'
import type { FiscalLinkedKind } from '@horizon/contracts'
import { PHASE45_FIXTURES, PHASE45_SCENARIOS } from './document-kinds'
import { PHASE41_SOURCE_SHA256 } from './phase41-approved-scenario'
import type { SourceImport } from './rule-store'

const PURPOSES = {
  'sale-return': { purpose: 'return', formula: 'RETURN_LINE_NET_TIMES_RATE' },
  'purchase-return': { purpose: 'return', formula: 'RETURN_LINE_NET_TIMES_RATE' },
  'value-complement': { purpose: 'complementary', formula: 'LINE_NET_TIMES_RATE' },
} as const satisfies Record<FiscalLinkedKind, { purpose: string; formula: string }>

/**
 * The Phase 45 interpretation over the same RTC V0057 reference rates as Phase 41: a
 * return reverses and a value complement adds tax at the rates of the original sale. It
 * is a separate package so its own review, and not the Phase 41 one, approves it.
 */
export function approvedPhase45Source(tenantId: string): SourceImport {
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      interpretation: 'phase45-linked-documents-v1',
      artifactDigest: PHASE41_SOURCE_SHA256,
      embeddedDatabase: 'V0057',
      fixtureIds: Object.values(PHASE45_FIXTURES),
    }),
  )
  const kinds = Object.keys(PHASE45_SCENARIOS) as FiscalLinkedKind[]
  return {
    tenantId,
    authority: 'Receita Federal do Brasil / SERPRO — Calculadora RTC V0057 (Phase 45 reading)',
    sourceUri: 'https://obs-13820-calcpr-apr.obsv3.br-df-1.hcs.serpro.gov.br/calculadora.zip',
    publishedAt: '2026-09-10',
    effectiveFrom: '2026-01-01',
    importedBy: 'agent:claude',
    bytes: manifest,
    entries: [],
    rules: kinds.flatMap((kind) =>
      [
        ['CBS', { numerator: '9', denominator: '1000' }, 'CBS'],
        ['IBS_UF', { numerator: '1', denominator: '1000' }, 'IBSUF'],
        ['IBS_MUN', { numerator: '0', denominator: '1' }, 'IBSMun'],
      ].map(([code, rate, sigla]) => ({
        ruleKey: `rtc.v0057.model55.${kind}.${String(code).toLowerCase().replace('_', '')}`,
        version: 1,
        group: 'ibsCbs' as const,
        code: code as string,
        precedence: 'operation' as const,
        priority: 500,
        model: '55' as const,
        environment: 'simulation' as const,
        operation: PHASE45_SCENARIOS[kind],
        issuerRegime: 'normal',
        recipientRegime: 'normal',
        originState: '35',
        destinationState: '35',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2027-01-01',
        purpose: PURPOSES[kind].purpose,
        formula: PURPOSES[kind].formula,
        rate: rate as { numerator: string; denominator: string },
        sourceLocator: `calculadora-pro.db:ALIQUOTA_REFERENCIA:TBTO_SIGLA=${sigla}:2026`,
      })),
    ),
  }
}

export function phase45SourceDigest(tenantId: string): string {
  return createHash('sha256').update(approvedPhase45Source(tenantId).bytes).digest('hex')
}
