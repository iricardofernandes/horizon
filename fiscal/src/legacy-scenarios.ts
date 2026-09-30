import type { FiscalCalculationInput, FiscalCalculationOutcome } from '@horizon/contracts'
import { calculateFiscal } from './calculation'
import { canonicalDigest } from './canonical-json'
import type { CatalogPublication } from './catalog'
import {
  BAHIA,
  DECLARED_NCM,
  DECLARED_SERVICE,
  FACTS,
  publicationAsTaxRules,
  RIO_DE_JANEIRO,
  SAO_PAULO,
  SAO_PAULO_CITY,
} from './legacy-packages'
import { deterministicUuid } from './rule-rows'
import { resolveTaxRules } from './rules'

/**
 * The declared legacy-tax scenarios of Phase 85. Each becomes a fixture the workspace owner
 * reviews: its input, the result the packages give, and what the scenario covers. A fixture
 * supports nothing until it is approved (ADR 0072).
 */

export const DEMO_WORKSPACE = '01a0b6b8-c334-7136-8144-e48a7ba17e08'
const RIO_CITY = '3304557'
const SALVADOR = '2927408'

export type Scenario = {
  id: string
  title: string
  covers: {
    model: '55' | 'nfse'
    from: string
    /** The first day a covered tax's law changes: 2027 for PIS/Cofins and IPI, 2029 for ICMS and ISS. */
    until: string
    taxes: string[]
    originState: string
    destinationState: string
    recipientTaxpayer: boolean
    issuerRegime?: string
    classification: { kind: 'ncm' | 'service'; code: string }
    facts: Record<string, string>
    origin?: string
    issuerMunicipality?: string
  }
  input: FiscalCalculationInput
}

type Party = { state: string; city: string }

export function goodsSale(options: {
  id: string
  issuerRegime: string
  destination: Party
  recipientTaxpayer: boolean
  facts: Record<string, string>
  origin?: string
}): FiscalCalculationInput {
  return {
    schemaVersion: 1,
    tenantId: DEMO_WORKSPACE,
    issuerEstablishmentId: DEMO_WORKSPACE,
    model: '55',
    environment: 'simulation',
    operation: 'sale',
    purpose: 'normal',
    issuer: {
      regime: options.issuerRegime,
      stateCode: SAO_PAULO,
      municipalityCode: SAO_PAULO_CITY,
    },
    recipient: {
      regime: options.recipientTaxpayer ? 'normal' : 'non-contributor',
      stateCode: options.destination.state,
      municipalityCode: options.destination.city,
      taxpayer: options.recipientTaxpayer,
    },
    origin: { countryCode: '1058', stateCode: SAO_PAULO, municipalityCode: SAO_PAULO_CITY },
    destination: {
      countryCode: '1058',
      stateCode: options.destination.state,
      municipalityCode: options.destination.city,
    },
    issueDate: '2026-10-15',
    currency: 'BRL',
    lines: [
      {
        id: deterministicUuid('phase85', options.id, 'line'),
        itemId: deterministicUuid('phase85', 'item', DECLARED_NCM),
        quantity: '2',
        unitPrice: '189.9',
        discount: { amount: '0', currency: 'BRL' },
        charges: { amount: '0', currency: 'BRL' },
        classifications: { ncm: DECLARED_NCM, origin: options.origin ?? '0' },
        taxFacts: options.facts,
      },
    ],
  }
}

const SP: Party = { state: SAO_PAULO, city: SAO_PAULO_CITY }
const RJ: Party = { state: RIO_DE_JANEIRO, city: RIO_CITY }
const BA: Party = { state: BAHIA, city: SALVADOR }
const resale = { [FACTS.destinationUse]: 'resale' }
const industrialResale = { [FACTS.ipiTaxpayer]: 'true', [FACTS.destinationUse]: 'resale' }
const industrial = { [FACTS.ipiTaxpayer]: 'true' }

/** EC 132 ADCT art. 126 (PIS/Cofins end and IPI goes to zero in 2027) and art. 128 (2029). */
function windowOf(taxes: readonly string[]) {
  const reform = taxes.some((tax) => tax === 'PIS' || tax === 'COFINS' || tax === 'IPI')
  return { from: '2026-01-01', until: reform ? '2027-01-01' : '2029-01-01' }
}

export function scenarios(): Scenario[] {
  const goods = (
    id: string,
    title: string,
    taxes: string[],
    options: Parameters<typeof goodsSale>[0],
  ): Scenario => ({
    id,
    title,
    covers: {
      model: '55',
      ...windowOf(taxes),
      taxes,
      originState: SAO_PAULO,
      destinationState: options.destination.state,
      recipientTaxpayer: options.recipientTaxpayer,
      ...(options.issuerRegime === 'normal' ? {} : { issuerRegime: options.issuerRegime }),
      classification: { kind: 'ncm', code: DECLARED_NCM },
      facts: options.facts,
      ...(options.origin ? { origin: options.origin } : {}),
    },
    input: goodsSale(options),
  })
  return [
    goods(
      'phase85-f1-sp-sp-resale-lucro-real',
      'SP → SP, contributor buying to resell; Lucro Real seller',
      ['ICMS', 'PIS', 'COFINS'],
      {
        id: 'f1',
        issuerRegime: 'lucro-real',
        destination: SP,
        recipientTaxpayer: true,
        facts: resale,
      },
    ),
    goods('phase85-f2-sp-rj-resale', 'SP → RJ, contributor buying to resell', ['ICMS'], {
      id: 'f2',
      issuerRegime: 'normal',
      destination: RJ,
      recipientTaxpayer: true,
      facts: resale,
    }),
    goods('phase85-f3-sp-ba-resale', 'SP → BA, contributor buying to resell', ['ICMS'], {
      id: 'f3',
      issuerRegime: 'normal',
      destination: BA,
      recipientTaxpayer: true,
      facts: resale,
    }),
    goods(
      'phase85-f4-sp-rj-imported-resale',
      'SP → RJ, imported goods (origin 1), contributor buying to resell',
      ['ICMS'],
      {
        id: 'f4',
        issuerRegime: 'normal',
        destination: RJ,
        recipientTaxpayer: true,
        facts: resale,
        origin: '1',
      },
    ),
    goods(
      'phase85-f5-sp-rj-non-contributor-lucro-presumido',
      'SP industrial → RJ non-contributor final consumer; Lucro Presumido seller',
      ['IPI', 'ICMS', 'ICMS_UF_DEST', 'FCP_UF_DEST', 'PIS', 'COFINS'],
      {
        id: 'f5',
        issuerRegime: 'lucro-presumido',
        destination: RJ,
        recipientTaxpayer: false,
        facts: industrial,
      },
    ),
    goods(
      'phase85-f6-sp-sp-industrial-resale',
      'SP industrial → SP contributor buying to resell',
      ['IPI', 'ICMS'],
      {
        id: 'f6',
        issuerRegime: 'normal',
        destination: SP,
        recipientTaxpayer: true,
        facts: industrialResale,
      },
    ),
    {
      id: 'phase85-f8-nfse-sao-paulo-1-01',
      title: 'NFS-e, provider in São Paulo, LC 116 subitem 1.01',
      covers: {
        model: 'nfse',
        ...windowOf(['ISS']),
        taxes: ['ISS'],
        originState: SAO_PAULO,
        destinationState: SAO_PAULO,
        recipientTaxpayer: true,
        classification: { kind: 'service', code: DECLARED_SERVICE },
        facts: {},
        issuerMunicipality: SAO_PAULO_CITY,
      },
      input: {
        ...goodsSale({
          id: 'f8',
          issuerRegime: 'normal',
          destination: SP,
          recipientTaxpayer: true,
          facts: {},
        }),
        model: 'nfse',
        lines: [
          {
            id: deterministicUuid('phase85', 'f8', 'line'),
            serviceId: deterministicUuid('phase85', 'service', DECLARED_SERVICE),
            quantity: '1',
            unitPrice: '1500',
            discount: { amount: '0', currency: 'BRL' },
            charges: { amount: '0', currency: 'BRL' },
            classifications: { service: DECLARED_SERVICE },
            taxFacts: {},
          },
        ],
      },
    },
  ]
}

export type Approval = {
  approvedBy: string
  approvedAt: string
  scope: string
  fixtureDigest: string
}

export type Fixture = {
  schemaVersion: 1
  fixtureId: string
  title: string
  covers: Scenario['covers']
  packages: { label: string; packageDigest: string }[]
  input: FiscalCalculationInput
  expectedResult: FiscalCalculationOutcome
  /** Null until the workspace owner approves this exact fixture. */
  approval: Approval | null
}

/** What an approval signs: everything but the approval itself. */
export const fixtureDigest = (fixture: Omit<Fixture, 'approval'>) =>
  canonicalDigest({ ...fixture, approval: undefined })

/** The result a scenario gets from the packages, as the store resolves them once adopted. */
export function expectedResult(
  scenario: Scenario,
  packages: readonly CatalogPublication[],
): FiscalCalculationOutcome {
  const rules = packages.flatMap((pack) => publicationAsTaxRules(pack, scenario.input.tenantId))
  const resolution = resolveTaxRules(scenario.input, rules, 2)
  if (!resolution.supported) return { schemaVersion: 1, ...resolution } as FiscalCalculationOutcome
  return calculateFiscal(scenario.input, resolution.rules)
}
