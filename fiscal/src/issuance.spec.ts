import { randomUUID } from 'node:crypto'
import type { FiscalCalculationInput, FiscalCalculationResult } from '@horizon/contracts'
import { describe, expect, it } from 'vitest'
import { buildNfe55Data, type Nfe55SimulationProfile } from './issuance'
import { serializeNfe55 } from './nfe55/xml'
import type { IssuerFiscalExport, PartyFiscalExport } from './projections'

describe('NF-e issuance mapping', () => {
  it('maps only frozen origin, projection, calculation and reviewed profile facts', () => {
    const itemId = randomUUID()
    const lineId = randomUUID()
    const documentId = randomUUID()
    const calculationInput = calculationInputFixture(itemId, lineId)
    const calculation = calculationResultFixture(calculationInput)
    const profile: Nfe55SimulationProfile = {
      capabilityId: randomUUID(),
      issuerAddress: {
        street: 'Rua do Café',
        number: '42',
        complement: null,
        district: 'Centro',
      },
      lineFacts: {
        [itemId]: {
          productCode: 'CAFE-001',
          cfop: '5102',
          unit: 'UN',
          ibsCbsCst: '000',
          ibsCbsClassification: '000001',
        },
      },
    }
    const candidate = {
      document: {
        id: documentId,
        status: 'ready' as const,
        simulated: true as const,
        snapshotDigest: '1'.repeat(64),
        model: '55' as const,
        environment: 'simulation' as const,
        establishmentId: calculationInput.issuerEstablishmentId,
        series: 1,
        number: 1,
        rootDocumentId: documentId,
        predecessorDocumentId: null,
        revision: 1,
        origin: { kind: 'sales' as const, intentId: randomUUID() },
        accessKey: null,
        calculationDigest: calculation.resultDigest,
        signedXmlDigest: null,
        adapterVersion: null,
        schemaPackageDigest: null,
        statusUrl: `/fiscal/documents/${documentId}`,
        createdAt: '2026-09-22T15:00:00.000Z',
      },
      number: 1,
      issuer: issuerFixture(calculationInput.tenantId),
      recipient: recipientFixture(
        calculationInput.tenantId,
        calculationInput.recipientPartyId as string,
      ),
      calculation: { input: calculationInput, result: calculation },
      origin: {
        orderId: randomUUID(),
        originModule: 'sales' as const,
        originDocumentType: 'shipment' as const,
        originId: randomUUID(),
        purpose: 'original' as const,
        customerId: calculationInput.recipientPartyId as string,
        lines: [
          {
            lineId,
            itemId,
            quantity: '1',
            description: 'Café torrado em grãos',
            unitPrice: money('10000'),
            lineTotal: money('10000'),
          },
        ],
        total: money('10000'),
      },
      profile,
    }
    const first = buildNfe55Data(candidate)
    const second = buildNfe55Data(candidate)
    expect(second).toEqual(first)
    expect(first).toMatchObject({
      issuedAt: '2026-09-22T12:00:00-03:00',
      series: 1,
      number: 1,
      lines: [
        {
          ncm: '09012100',
          cfop: '5102',
          quantity: '1.0000',
          gross: '100.00',
          ibsCbs: {
            base: '100.00',
            ibsUfRate: '0.1000',
            ibsUfValue: '0.10',
            cbsRate: '0.9000',
            cbsValue: '0.90',
          },
        },
      ],
      totals: { invoice: '100.00', invoiceWithIbsCbs: '101.00' },
    })
    expect(serializeNfe55(first).toString()).toContain(
      `<CNPJ>${issuerFixture('').company.taxId}</CNPJ>`,
    )
  })
})

function calculationInputFixture(itemId: string, lineId: string): FiscalCalculationInput {
  const tenantId = randomUUID()
  return {
    schemaVersion: 1,
    tenantId,
    issuerEstablishmentId: randomUUID(),
    issuerProfileRevision: 3,
    recipientPartyId: randomUUID(),
    recipientProfileRevision: 7,
    model: '55',
    environment: 'simulation',
    operation: 'rtc-v0057-model55-normal-sale',
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
        id: lineId,
        itemId,
        classificationRevision: 11,
        quantity: '1',
        unitPrice: '100',
        discount: money('0'),
        charges: money('0'),
        classifications: { ncm: '09012100' },
        taxFacts: {},
      },
    ],
  }
}

function calculationResultFixture(input: FiscalCalculationInput): FiscalCalculationResult {
  const lineId = input.lines[0]?.id as string
  const component = (code: string, numerator: string, amount: string) => ({
    code,
    base: money('10000'),
    rate: { numerator, denominator: '1000' },
    unrounded: { numerator: amount, denominator: '1', currency: 'BRL' },
    amount: money(amount),
    formula: 'LINE_NET_TIMES_RATE',
    rounding: { mode: 'half-away-from-zero' as const, scale: 2 },
    rule: { id: randomUUID(), version: 1 },
    source: {
      packageId: randomUUID(),
      digest: '2'.repeat(64),
      uri: 'https://example.invalid/source',
      section: `fixture:${code}`,
    },
  })
  return {
    schemaVersion: 1,
    supported: true,
    inputDigest: '3'.repeat(64),
    rulesDigest: '4'.repeat(64),
    resultDigest: '5'.repeat(64),
    lines: [
      {
        lineId,
        gross: money('10000'),
        net: money('10000'),
        components: {
          legacy: [],
          ibsCbs: [
            component('CBS', '9', '90'),
            component('IBS_UF', '1', '10'),
            component('IBS_MUN', '0', '0'),
          ],
        },
      },
    ],
    totals: {
      gross: money('10000'),
      discounts: money('0'),
      charges: money('0'),
      net: money('10000'),
      legacyTax: money('0'),
      ibsCbsTax: money('100'),
    },
    reconciliation: {
      lineNetSum: money('10000'),
      legacyComponentSum: money('0'),
      ibsCbsComponentSum: money('100'),
      balanced: true,
    },
    explanation: { templateVersion: 'test-v1', text: 'Frozen calculation fixture' },
  }
}

function issuerFixture(tenantId: string): IssuerFiscalExport {
  return {
    tenantId: tenantId || randomUUID(),
    revision: 3,
    effectiveFrom: '2026-01-01',
    timezone: 'America/Sao_Paulo',
    company: {
      legalName: 'Horizon Café Simulação LTDA',
      tradeName: null,
      taxId: '00000000E08G12',
      stateRegistration: '123456789',
      municipalRegistration: null,
      address: {
        line: 'Rua do Café, 42',
        city: 'São Paulo',
        municipalityCode: '3550308',
        state: 'SP',
        postalCode: '01001000',
        country: 'BR',
      },
      baseCurrency: 'BRL',
      fiscalRegime: 'lucro-real',
    },
  }
}

function recipientFixture(tenantId: string, partyId: string): PartyFiscalExport {
  return {
    tenantId,
    partyId,
    kind: 'organization',
    legalName: 'Cliente Simulado LTDA',
    tradeName: null,
    taxId: '11222333000181',
    revision: 7,
    profile: {
      effectiveFrom: '2026-01-01',
      stateRegistration: '987654321',
      municipalRegistration: null,
      taxpayerIndicator: 'contributor',
      finalConsumer: false,
      address: {
        street: 'Avenida Paulista',
        number: '1000',
        complement: null,
        district: 'Bela Vista',
        city: 'São Paulo',
        municipalityCode: '3550308',
        state: 'SP',
        postalCode: '01310100',
        country: 'BR',
      },
    },
  }
}

function money(amount: string) {
  return { amount, currency: 'BRL' }
}
