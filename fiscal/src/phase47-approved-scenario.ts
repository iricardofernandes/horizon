import type { FiscalNfseRegistryVersionRequest } from '@horizon/contracts'
import type { NfseIbsCbsRates, NfseMunicipalParameters } from './nfse/simulator'
import { PHASE41_SOURCE_SHA256 } from './phase41-approved-scenario'
import type { SourceImport } from './rule-store'

export const PHASE47_FIXTURE = 'rtc-v0057-nfse-service-provision-2026-01'
export const PHASE47_ADAPTER = 'nfse-national-simulator-v1'
export const PHASE47_SERVICE_CODE = '010101'

/**
 * The ISS rate depends on the municipality, so each municipality has its own reviewed
 * rule set and calculation operation.
 */
export function phase47Scenario(municipalityCode: string): string {
  return `rtc-v0057-nfse-service-${municipalityCode}`
}

/** The adhering-municipalities list of 2026-09-18 (fiscal/fixtures/official/phase47-source-manifest.json). */
export const PHASE47_REGISTRY_SOURCE = {
  uri: 'https://www.gov.br/nfse/pt-br/municipios/monitoramento-adesoes/municipios-aderentes-20260918.xlsx',
  sha256: '8c3b302f8e99fe7ae5cc71be3a26ac6f919e10c552e371b3412a0f842059cd07',
  publishedOn: '2026-09-18',
} as const

/**
 * The reviewed rows of that list: São Paulo issues through the national public issuer;
 * Campinas shares with the national environment but issues in its own system.
 */
export function phase47RegistryVersion(): FiscalNfseRegistryVersionRequest {
  return {
    sourceUri: PHASE47_REGISTRY_SOURCE.uri,
    sourceDigest: PHASE47_REGISTRY_SOURCE.sha256,
    publishedOn: PHASE47_REGISTRY_SOURCE.publishedOn,
    entries: [
      {
        municipalityCode: '3550308',
        uf: 'SP',
        name: 'São Paulo',
        agreement: 'active',
        nationalEnvironment: true,
        nationalIssuer: true,
        startsOn: '2025-12-22',
        sourceLocator:
          'municipios-aderentes-20260918.xlsx:row 4301 (SAO PAULO, CNPJ 46395000000139)',
      },
      {
        municipalityCode: '3509502',
        uf: 'SP',
        name: 'Campinas',
        agreement: 'active',
        nationalEnvironment: true,
        nationalIssuer: false,
        startsOn: '2025-11-16',
        sourceLocator:
          'municipios-aderentes-20260918.xlsx:row 3845 (CAMPINAS, CNPJ 51885242000140)',
      },
    ],
  }
}

/** RTC V0057 2026 reference rates, as the model 55 and 65 fixtures. */
export const PHASE47_IBS_CBS_RATES: NfseIbsCbsRates = {
  cbs: { numerator: '9', denominator: '1000' },
  ibsUf: { numerator: '1', denominator: '1000' },
  ibsMun: { numerator: '0', denominator: '1' },
}

/**
 * The municipal parameters of the simulated national system. The ISS rate and the
 * deadlines are the workspace owner's provisional simulation reading: the official ones
 * come from `/parametros_municipais`, which needs an ICP-Brasil certificate.
 */
export const PHASE47_MUNICIPAL_PARAMETERS: readonly NfseMunicipalParameters[] = [
  {
    municipalityCode: '3550308',
    agreement: 'active',
    nationalIssuer: true,
    startsOn: '2025-12-22',
    issRates: { [PHASE47_SERVICE_CODE]: { numerator: '2', denominator: '100' } },
    cancellationWindowDays: 30,
  },
  {
    municipalityCode: '3509502',
    agreement: 'active',
    nationalIssuer: false,
    startsOn: '2025-11-16',
    issRates: {},
    cancellationWindowDays: 30,
  },
]

const common = {
  model: 'nfse' as const,
  environment: 'simulation' as const,
  precedence: 'operation' as const,
  priority: 500,
  dateBasis: 'competence_date' as const,
  issuerRegime: 'normal',
  effectiveFrom: '2026-01-01',
  effectiveTo: '2027-01-01',
  purpose: 'normal' as const,
  formula: 'LINE_NET_TIMES_RATE' as const,
}

/**
 * The Phase 47 reading of the RTC V0057 reference rates for a service provision in one
 * municipality: CBS and IBS on the service value, selected by competence date.
 */
export function approvedPhase47IbsCbsSource(
  tenantId: string,
  municipalityCode: string,
): SourceImport {
  const operation = phase47Scenario(municipalityCode)
  return {
    tenantId,
    authority: 'Receita Federal do Brasil / SERPRO — Calculadora RTC V0057 (Phase 47 reading)',
    sourceUri: 'https://obs-13820-calcpr-apr.obsv3.br-df-1.hcs.serpro.gov.br/calculadora.zip',
    publishedAt: '2026-09-10',
    effectiveFrom: '2026-01-01',
    importedBy: 'agent:claude',
    bytes: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        interpretation: 'phase47-nfse-service-provision-ibs-cbs-v1',
        artifactDigest: PHASE41_SOURCE_SHA256,
        embeddedDatabase: 'V0057',
        municipalityCode,
        fixtureIds: [PHASE47_FIXTURE],
      }),
    ),
    entries: [serviceEntry()],
    rules: [
      ['CBS', PHASE47_IBS_CBS_RATES.cbs, 'CBS'],
      ['IBS_UF', PHASE47_IBS_CBS_RATES.ibsUf, 'IBSUF'],
      ['IBS_MUN', PHASE47_IBS_CBS_RATES.ibsMun, 'IBSMun'],
    ].map(([code, rate, sigla]) => ({
      ...common,
      ruleKey: `rtc.v0057.nfse.${municipalityCode}.${String(code).toLowerCase().replace('_', '')}`,
      version: 1,
      group: 'ibsCbs' as const,
      code: code as string,
      operation,
      classification: { kind: 'service' as const, code: PHASE47_SERVICE_CODE },
      rate: rate as { numerator: string; denominator: string },
      sourceLocator: `calculadora-pro.db:ALIQUOTA_REFERENCIA:TBTO_SIGLA=${String(sigla)}:2026`,
    })),
  }
}

/** The municipal ISS parameter for the service, as the owner provisionally read it. */
export function approvedPhase47IssSource(tenantId: string, municipalityCode: string): SourceImport {
  const parameters = PHASE47_MUNICIPAL_PARAMETERS.find(
    (entry) => entry.municipalityCode === municipalityCode,
  )
  const rate = parameters?.issRates[PHASE47_SERVICE_CODE]
  if (!rate) throw new Error('No reviewed ISS parameter for this municipality and service')
  return {
    tenantId,
    authority: `Município ${municipalityCode} — parâmetro municipal de ISS (Phase 47 provisional reading)`,
    sourceUri: `https://sefin.nfse.gov.br/SefinNacional/parametros_municipais/${municipalityCode}/${PHASE47_SERVICE_CODE}`,
    publishedAt: '2026-09-26',
    effectiveFrom: '2026-01-01',
    importedBy: 'agent:claude',
    bytes: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        interpretation: 'phase47-municipal-iss-provisional-v1',
        municipalityCode,
        service: PHASE47_SERVICE_CODE,
        rate,
        retrieved: false,
        reason: 'The municipal parameter API needs an ICP-Brasil client certificate.',
        fixtureIds: [PHASE47_FIXTURE],
      }),
    ),
    entries: [serviceEntry()],
    rules: [
      {
        ...common,
        ruleKey: `nfse.${municipalityCode}.iss.${PHASE47_SERVICE_CODE}`,
        version: 1,
        group: 'legacy' as const,
        code: 'ISS',
        operation: phase47Scenario(municipalityCode),
        classification: { kind: 'service' as const, code: PHASE47_SERVICE_CODE },
        rate,
        sourceLocator: `parametros_municipais/${municipalityCode}/${PHASE47_SERVICE_CODE}:owner-provisional`,
      },
    ],
  }
}

function serviceEntry() {
  return {
    family: 'service' as const,
    code: PHASE47_SERVICE_CODE,
    description: 'Análise e desenvolvimento de sistemas (LC 116 1.01, desdobro 01)',
    model: 'nfse' as const,
    jurisdiction: 'BR',
    effectiveFrom: '2026-01-01',
    effectiveTo: '9999-12-31',
    sourceLocator:
      'anexo_b-nbs2-lista_servico_nacional-snnfse-v1-01-20260122.xlsx:LISTA.SERV.NAC.:10101',
  }
}

/** SHA-256 of `fiscal/fixtures/official/phase47-source-manifest.json`, the capability's source manifest. */
export const PHASE47_SOURCE_MANIFEST_DIGEST =
  '03f40ff13a576f5849888c421f58a8ee1eda0ec75f166aa09cb2e1801a17b7d9'
