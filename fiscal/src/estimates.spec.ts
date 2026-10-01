import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FiscalCalculationInput } from '@horizon/contracts'
import { describe, expect, it } from 'vitest'
import { calculateFiscal } from './calculation'
import { FiscalEstimates } from './estimates'
import {
  DECLARED_NCM,
  goodsPackage,
  issPackage,
  publicationAsTaxRules,
  type SourceManifest,
} from './legacy-packages'
import { approvedPhase41Publication } from './phase41-approved-scenario'
import type { IssuerFiscalExport, PartyFiscalExport } from './projections'
import { blendPackage, pisCofinsNormalPackage, simplesMeiPackage } from './regime-packages'
import { resolveTaxRules } from './rules'

const DOCS = join(__dirname, '..', '..', 'docs')
const hasRepository = existsSync(join(DOCS, 'tax-phase86-source-manifest.json'))
const tenantId = '01a0b6b8-c334-7136-8144-e48a7ba17e08'
const itemId = '018f5d4e-1000-7000-8000-0000000000a1'
const partyId = '018f5d4e-1000-7000-8000-0000000000a2'
const address = (state: string, municipalityCode: string) => ({
  street: 'Rua A',
  number: '1',
  complement: null,
  district: 'Centro',
  city: 'Cidade',
  municipalityCode,
  state,
  postalCode: '01000000',
  country: 'BR',
})

function issuer(fiscalRegime: IssuerFiscalExport['company']['fiscalRegime']): IssuerFiscalExport {
  return {
    tenantId,
    revision: 1,
    effectiveFrom: '2026-01-01',
    timezone: 'America/Sao_Paulo',
    company: {
      legalName: 'Horizon Demo',
      tradeName: null,
      taxId: '12345678000199',
      stateRegistration: '110042490114',
      municipalRegistration: null,
      address: {
        line: null,
        city: 'São Paulo',
        municipalityCode: '3550308',
        state: 'SP',
        postalCode: '01000000',
        country: 'BR',
      },
      baseCurrency: 'BRL',
      fiscalRegime,
    },
  } as IssuerFiscalExport
}

const party = (state: string, city: string): PartyFiscalExport => ({
  tenantId,
  partyId,
  kind: 'organization',
  legalName: 'Cliente',
  tradeName: null,
  taxId: '98765432000155',
  revision: 1,
  profile: {
    effectiveFrom: '2026-01-01',
    stateRegistration: '110042490114',
    municipalRegistration: null,
    taxpayerIndicator: 'contributor',
    finalConsumer: false,
    address: address(state, city),
  },
})

async function engine(
  fiscalRegime: IssuerFiscalExport['company']['fiscalRegime'],
  customer = party('SP', '3550308'),
  ipiTaxpayer = false,
) {
  const sources = (
    await Promise.all(
      ['82', '85', '86'].map(
        async (phase) =>
          (
            JSON.parse(
              await readFile(join(DOCS, `tax-phase${phase}-source-manifest.json`), 'utf8'),
            ) as SourceManifest
          ).sources,
      ),
    )
  ).flat()
  const manifest = { sources }
  const packs = [
    approvedPhase41Publication({ byteSize: 1 }),
    goodsPackage(manifest, new Map([[DECLARED_NCM, '6.5']]), [DECLARED_NCM]),
    issPackage(manifest),
    pisCofinsNormalPackage(manifest),
    simplesMeiPackage(manifest),
    blendPackage(manifest),
  ]
  const rules = packs.flatMap((pack) => publicationAsTaxRules(pack, tenantId))
  const preview = async (input: FiscalCalculationInput) => {
    const resolution = resolveTaxRules(input, rules, 2)
    if (!resolution.supported)
      return { schemaVersion: 1 as const, ...resolution, inputDigest: '0'.repeat(64) }
    return calculateFiscal(input, resolution.rules)
  }
  return new FiscalEstimates(
    {
      resolveIssuer: async () => issuer(fiscalRegime),
      resolveParty: async () => customer,
      resolveClassification: async () => ({
        itemId,
        revision: 1,
        effectiveFrom: '2026-01-01',
        ncm: DECLARED_NCM,
        ipiTaxpayer,
      }),
    },
    { preview: preview as never },
    undefined,
    () => new Date('2026-10-15T12:00:00Z'),
  )
}

const sale = (facts?: Record<string, string>) => ({
  direction: 'sale' as const,
  establishmentId: tenantId,
  customerPartyId: partyId,
  issueDate: '2026-10-15',
  lines: [
    {
      itemId,
      quantity: '2',
      unitPrice: { amount: '18990', currency: 'BRL' },
      ...(facts ? { facts } : {}),
    },
  ],
})

describe.skipIf(!hasRepository)('a tax estimate (Phase 87)', () => {
  it('derives a sale as readiness would, and sums each component with the totals', async () => {
    const estimate = await (await engine('lucro-real')).estimate(
      tenantId,
      sale({ destinationUse: 'resale' }),
    )
    if (!estimate.supported) throw new Error(JSON.stringify(estimate))
    const amounts = Object.fromEntries(estimate.components.map((c) => [c.code, c.amount.amount]))
    // Phase 41's sale (CBS, IBS) beside Phase 85's ICMS and Phase 86's PIS/Cofins for a Real issuer.
    expect(amounts).toMatchObject({
      ICMS: '6836',
      PIS: '514',
      COFINS: '2367',
      CBS: '342',
      IBS_UF: '38',
    })
    expect(estimate.totals.chargedOnTop.amount).toBe('0')
    expect(estimate.totals.gross.amount).toBe('37980')
  })

  it('refuses what could not be issued, naming what is missing', async () => {
    // Without the fact, no ICMS rule applies; the scenario is still the Phase 41 sale alone.
    const plain = await (await engine('lucro-real')).estimate(tenantId, sale())
    expect(plain.supported).toBe(true)
    const interstate = await (await engine('lucro-real', party('RJ', '3304557'))).estimate(
      tenantId,
      sale({ destinationUse: 'resale' }),
    )
    expect(interstate).toMatchObject({ supported: false })
  })

  it('asks a purchase for the supplier regime and never infers it', async () => {
    const estimates = await engine('lucro-real')
    await expect(
      estimates.estimate(tenantId, { ...sale(), direction: 'purchase', supplierPartyId: partyId }),
    ).rejects.toThrow()
    const purchase = await estimates.estimate(tenantId, {
      direction: 'purchase',
      establishmentId: tenantId,
      supplierPartyId: partyId,
      supplier: { regime: 'normal', incomeTaxRegime: 'lucro-presumido' },
      issueDate: '2026-10-15',
      lines: [
        {
          itemId,
          quantity: '2',
          unitPrice: { amount: '18990', currency: 'BRL' },
          facts: { destinationUse: 'resale' },
        },
      ],
    })
    if (!purchase.supported) throw new Error(JSON.stringify(purchase))
    expect(Object.fromEntries(purchase.components.map((c) => [c.code, c.amount.amount]))).toEqual({
      ICMS: '6836',
      PIS: '202',
      COFINS: '934',
      // The supplier's sale is the reviewed normal sale, so its CBS/IBS of 2026 are there too.
      CBS: '342',
      IBS_UF: '38',
      IBS_MUN: '0',
    })
  })

  it("states a sale line's facts from the customer's profile and the item's classification (Phase 89)", async () => {
    const reseller = party('SP', '3550308')
    const stated = {
      ...reseller,
      profile: { ...reseller.profile, goodsDestination: 'resale' as const },
    }
    const estimate = await (await engine('lucro-real', stated, true)).estimate(tenantId, sale())
    if (!estimate.supported) throw new Error(JSON.stringify(estimate))
    const codes = estimate.components.map((component) => component.code)
    // Resale to a contributor brings ICMS; an IPI taxpayer for the item brings IPI.
    expect(codes).toEqual(expect.arrayContaining(['ICMS', 'IPI', 'PIS', 'COFINS']))
    expect(estimate.totals.chargedOnTop.amount).not.toBe('0')
  })
})
