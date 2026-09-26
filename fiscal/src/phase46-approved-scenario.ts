import { PHASE46_FIXTURE, PHASE46_SCENARIO } from './document-kinds'
import { PHASE41_SOURCE_SHA256 } from './phase41-approved-scenario'
import type { SourceImport } from './rule-store'

/**
 * The Phase 46 interpretation over the same RTC V0057 reference rates as Phase 41, for a
 * consumer sale on an NFC-e model 65. It is its own package, so a model 65 review, and not
 * the model 55 one, approves it. The rules require a non-contributor recipient regime.
 */
export function approvedPhase46Source(tenantId: string): SourceImport {
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      interpretation: 'phase46-nfce-consumer-sale-v1',
      artifactDigest: PHASE41_SOURCE_SHA256,
      embeddedDatabase: 'V0057',
      fixtureIds: [PHASE46_FIXTURE],
    }),
  )
  return {
    tenantId,
    authority: 'Receita Federal do Brasil / SERPRO — Calculadora RTC V0057 (Phase 46 reading)',
    sourceUri: 'https://obs-13820-calcpr-apr.obsv3.br-df-1.hcs.serpro.gov.br/calculadora.zip',
    publishedAt: '2026-09-10',
    effectiveFrom: '2026-01-01',
    importedBy: 'agent:claude',
    bytes: manifest,
    entries: [
      {
        family: 'ncm',
        code: '09012100',
        description: 'Café torrado, não descafeinado',
        model: '65',
        jurisdiction: 'BR',
        effectiveFrom: '2022-04-01',
        effectiveTo: '9999-12-31',
        sourceLocator: 'calculadora-pro.db:NCM:NCM_CD=09012100',
      },
    ],
    rules: [
      ['CBS', { numerator: '9', denominator: '1000' }, 'CBS'],
      ['IBS_UF', { numerator: '1', denominator: '1000' }, 'IBSUF'],
      ['IBS_MUN', { numerator: '0', denominator: '1' }, 'IBSMun'],
    ].map(([code, rate, sigla]) => ({
      ruleKey: `rtc.v0057.model65.consumer-sale.${String(code).toLowerCase().replace('_', '')}`,
      version: 1,
      group: 'ibsCbs' as const,
      code: code as string,
      precedence: 'operation' as const,
      priority: 500,
      model: '65' as const,
      environment: 'simulation' as const,
      operation: PHASE46_SCENARIO,
      issuerRegime: 'normal',
      recipientRegime: 'final-consumer',
      originState: '35',
      destinationState: '35',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2027-01-01',
      purpose: 'normal',
      formula: 'LINE_NET_TIMES_RATE' as const,
      rate: rate as { numerator: string; denominator: string },
      sourceLocator: `calculadora-pro.db:ALIQUOTA_REFERENCIA:TBTO_SIGLA=${sigla}:2026`,
    })),
  }
}
