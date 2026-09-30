import type { FiscalCalculationInput } from '@horizon/contracts'
import { issuerRegimeOf } from './issuer-regime'
import { DECLARED_NCM, DECLARED_SERVICE, FACTS, SAO_PAULO, SAO_PAULO_CITY } from './legacy-packages'
import { goodsSale, type Scenario } from './legacy-scenarios'
import { deterministicUuid } from './rule-rows'

/**
 * The declared scenarios of Phase 86: one SP → SP resale for each regime, a Simples
 * provider's NFS-e, a 2030 document in the blend, and a Simples exclusion on 1 July. The
 * regime each reads is the profile's, mapped as the input builders map it.
 */

type ProfileRegime = 'simples-nacional' | 'mei' | 'lucro-presumido' | 'lucro-real'

const SP = { state: SAO_PAULO, city: SAO_PAULO_CITY }
const resale = { [FACTS.destinationUse]: 'resale' }

function resaleBy(
  id: string,
  regime: ProfileRegime,
  issueDate: string,
  classTrib?: string,
): FiscalCalculationInput {
  const mapped = issuerRegimeOf(regime)
  if (!mapped) throw new Error(`${regime} is a declared regime`)
  const sale = goodsSale({
    id,
    issuerRegime: mapped.regime,
    destination: SP,
    recipientTaxpayer: true,
    facts: resale,
  })
  const [line] = sale.lines
  if (!line) throw new Error('a sale has a line')
  return {
    ...sale,
    issuer: { ...sale.issuer, ...mapped },
    issueDate,
    lines: [
      {
        ...line,
        classifications: { ...line.classifications, ...(classTrib ? { classTrib } : {}) },
      },
    ],
  }
}

function covers(
  taxes: string[],
  regime: ProfileRegime,
  window: { from: string; until: string },
): Scenario['covers'] {
  const mapped = issuerRegimeOf(regime)
  return {
    model: '55',
    ...window,
    taxes,
    originState: SAO_PAULO,
    destinationState: SAO_PAULO,
    recipientTaxpayer: true,
    issuerRegime: mapped?.regime ?? regime,
    classification: { kind: 'ncm', code: DECLARED_NCM },
    facts: resale,
  }
}

const Y2026 = { from: '2026-01-01', until: '2027-01-01' }
const DAS = ['ICMS', 'PIS', 'COFINS']
const SIMPLES_2026 = [...DAS, 'CBS', 'IBS_UF', 'IBS_MUN']

export function regimeScenarios(): Scenario[] {
  return [
    {
      id: 'phase86-g1-simples-resale',
      title: 'SP → SP resale by a Simples Nacional issuer (CSOSN 102), a classified line',
      covers: covers(SIMPLES_2026, 'simples-nacional', Y2026),
      input: resaleBy('g1', 'simples-nacional', '2026-10-15', '000001'),
    },
    {
      id: 'phase86-g2-mei-resale',
      title: 'SP → SP resale by an MEI (SIMEI), a classified line',
      covers: covers(SIMPLES_2026, 'mei', Y2026),
      input: resaleBy('g2', 'mei', '2026-10-15', '000001'),
    },
    {
      id: 'phase86-g3-presumido-resale',
      title: 'SP → SP resale by a Lucro Presumido issuer',
      covers: covers(DAS, 'lucro-presumido', Y2026),
      input: resaleBy('g3', 'lucro-presumido', '2026-10-15'),
    },
    {
      id: 'phase86-g4-real-resale',
      title: 'SP → SP resale by a Lucro Real issuer',
      covers: covers(DAS, 'lucro-real', Y2026),
      input: resaleBy('g4', 'lucro-real', '2026-10-15'),
    },
    {
      id: 'phase86-g5-simples-nfse-sao-paulo',
      title: 'NFS-e of a Simples Nacional provider in São Paulo, LC 116 subitem 1.01',
      covers: {
        model: 'nfse',
        from: '2026-01-01',
        until: '2033-01-01',
        taxes: ['ISS'],
        originState: SAO_PAULO,
        destinationState: SAO_PAULO,
        recipientTaxpayer: true,
        issuerRegime: 'simples-nacional',
        classification: { kind: 'service', code: DECLARED_SERVICE },
        facts: {},
        issuerMunicipality: SAO_PAULO_CITY,
      },
      input: {
        ...goodsSale({
          id: 'g5',
          issuerRegime: 'simples-nacional',
          destination: SP,
          recipientTaxpayer: true,
          facts: {},
        }),
        model: 'nfse',
        lines: [
          {
            id: deterministicUuid('phase86', 'g5', 'line'),
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
    {
      id: 'phase86-g6-blend-2030-real-resale',
      title: 'SP → SP resale by a Lucro Real issuer in 2030, ICMS at 8/10 of its rate',
      covers: covers(['ICMS'], 'lucro-real', { from: '2030-01-01', until: '2031-01-01' }),
      input: resaleBy('g6', 'lucro-real', '2030-03-15'),
    },
    {
      id: 'phase86-g7a-simples-before-exclusion',
      title: 'Excluded from the Simples on 1 July 2026: a sale on 30 June, still Simples',
      covers: covers(DAS, 'simples-nacional', { from: '2026-01-01', until: '2027-01-01' }),
      input: resaleBy('g7a', 'simples-nacional', '2026-06-30'),
    },
    {
      id: 'phase86-g7b-presumido-after-exclusion',
      title: 'Excluded from the Simples on 1 July 2026: a sale on 1 July, now Lucro Presumido',
      covers: covers(DAS, 'lucro-presumido', { from: '2026-01-01', until: '2027-01-01' }),
      input: resaleBy('g7b', 'lucro-presumido', '2026-07-01'),
    },
  ]
}
