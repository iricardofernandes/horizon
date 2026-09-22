import type { FiscalCalculationInput } from '@horizon/contracts'
import type { ResolvedRuleSet } from './calculation'
import type { SourceImport } from './rule-store'

export const PHASE41_SOURCE_SHA256 =
  'f451c3902621f02f3a63da29cd63d1e8e0f0456cce44425f1e22c89c079cb68e'
export const PHASE41_SCENARIO_ID = 'rtc-v0057-model55-normal-sale'
export const PHASE41_FIXTURE_ID = 'rtc-v0057-model55-normal-sale-sp-2026-01'

export function approvedPhase41Source(
  tenantId: string,
  artifact: { byteSize: number; storageUri: string },
): SourceImport {
  const commonRule = {
    version: 1,
    group: 'ibsCbs' as const,
    precedence: 'operation' as const,
    priority: 500,
    model: '55' as const,
    environment: 'simulation' as const,
    operation: PHASE41_SCENARIO_ID,
    issuerRegime: 'normal',
    recipientRegime: 'normal',
    originState: '35',
    destinationState: '35',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2027-01-01',
    formula: 'LINE_NET_TIMES_RATE' as const,
  }
  return {
    tenantId,
    authority: 'Receita Federal do Brasil / SERPRO — Calculadora RTC V0057',
    sourceUri: 'https://obs-13820-calcpr-apr.obsv3.br-df-1.hcs.serpro.gov.br/calculadora.zip',
    publishedAt: '2026-09-10',
    effectiveFrom: '2026-01-01',
    importedBy: 'agent:codex',
    bytes: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        artifactDigest: PHASE41_SOURCE_SHA256,
        embeddedDatabase: 'V0057',
        fixtureId: PHASE41_FIXTURE_ID,
      }),
    ),
    artifact: {
      digest: PHASE41_SOURCE_SHA256,
      byteSize: artifact.byteSize,
      storageUri: artifact.storageUri,
      verifiedAt: '2026-09-22T13:19:30.000Z',
    },
    entries: [
      {
        family: 'ncm',
        code: '09012100',
        description: 'Café torrado, não descafeinado',
        model: '55',
        jurisdiction: 'BR',
        effectiveFrom: '2022-04-01',
        effectiveTo: '9999-12-31',
        sourceLocator: 'calculadora-pro.db:NCM:NCM_CD=09012100',
      },
      ...['CBS', 'IBSUF', 'IBSMUN'].map((code) => ({
        family: 'ibs_cbs' as const,
        code,
        description: `RTC V0057 reference component ${code}`,
        model: '55' as const,
        jurisdiction: 'BR',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2027-01-01',
        sourceLocator: `calculadora-pro.db:ALIQUOTA_REFERENCIA:${code}:2026`,
      })),
    ],
    rules: [
      {
        ...commonRule,
        ruleKey: 'rtc.v0057.model55.normal-sale.cbs',
        code: 'CBS',
        rate: { numerator: '9', denominator: '1000' },
        sourceLocator: 'calculadora-pro.db:ALIQUOTA_REFERENCIA:TBTO_SIGLA=CBS:2026',
      },
      {
        ...commonRule,
        ruleKey: 'rtc.v0057.model55.normal-sale.ibsuf',
        code: 'IBS_UF',
        rate: { numerator: '1', denominator: '1000' },
        sourceLocator: 'calculadora-pro.db:ALIQUOTA_REFERENCIA:TBTO_SIGLA=IBSUF:2026',
      },
      {
        ...commonRule,
        ruleKey: 'rtc.v0057.model55.normal-sale.ibsmun',
        code: 'IBS_MUN',
        rate: { numerator: '0', denominator: '1' },
        sourceLocator: 'calculadora-pro.db:ALIQUOTA_REFERENCIA:TBTO_SIGLA=IBSMun:2026',
      },
    ],
  }
}

export function approvedPhase41Input(input: {
  tenantId: string
  establishmentId: string
  itemId: string
}): FiscalCalculationInput {
  return {
    schemaVersion: 1,
    tenantId: input.tenantId,
    issuerEstablishmentId: input.establishmentId,
    model: '55',
    environment: 'simulation',
    operation: PHASE41_SCENARIO_ID,
    purpose: 'normal',
    issuer: { regime: 'normal', stateCode: '35', municipalityCode: '3550308' },
    recipient: {
      regime: 'normal',
      stateCode: '35',
      municipalityCode: '3550308',
      taxpayer: true,
    },
    origin: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
    destination: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
    issueDate: '2026-09-22',
    currency: 'BRL',
    lines: [
      {
        id: '00000000-0000-4000-8000-000000000041',
        itemId: input.itemId,
        quantity: '1',
        unitPrice: '100',
        discount: { amount: '0', currency: 'BRL' },
        charges: { amount: '0', currency: 'BRL' },
        classifications: { ncm: '09012100' },
        taxFacts: {},
      },
    ],
  }
}

export function approvedPhase41ResolvedRules(input: {
  packageId: string
  cbsRuleId: string
  ibsUfRuleId: string
  ibsMunRuleId: string
}): ResolvedRuleSet {
  const source = (section: string) => ({
    packageId: input.packageId,
    digest: PHASE41_SOURCE_SHA256,
    uri: 'https://obs-13820-calcpr-apr.obsv3.br-df-1.hcs.serpro.gov.br/calculadora.zip',
    section,
    approved: true,
  })
  return {
    schemaVersion: 1,
    currencyMinorUnitScale: 2,
    explanationTemplateVersion: 'fiscal-explanation-v1',
    lines: {
      '00000000-0000-4000-8000-000000000041': [
        {
          group: 'ibsCbs',
          code: 'CBS',
          rate: { numerator: '9', denominator: '1000' },
          formula: 'LINE_NET_TIMES_RATE',
          rule: { id: input.cbsRuleId, version: 1 },
          source: source('calculadora-pro.db:ALIQUOTA_REFERENCIA:TBTO_SIGLA=CBS:2026'),
        },
        {
          group: 'ibsCbs',
          code: 'IBS_MUN',
          rate: { numerator: '0', denominator: '1' },
          formula: 'LINE_NET_TIMES_RATE',
          rule: { id: input.ibsMunRuleId, version: 1 },
          source: source('calculadora-pro.db:ALIQUOTA_REFERENCIA:TBTO_SIGLA=IBSMun:2026'),
        },
        {
          group: 'ibsCbs',
          code: 'IBS_UF',
          rate: { numerator: '1', denominator: '1000' },
          formula: 'LINE_NET_TIMES_RATE',
          rule: { id: input.ibsUfRuleId, version: 1 },
          source: source('calculadora-pro.db:ALIQUOTA_REFERENCIA:TBTO_SIGLA=IBSUF:2026'),
        },
      ],
    },
  }
}
