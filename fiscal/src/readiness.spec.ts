import { randomUUID } from 'node:crypto'
import {
  type FiscalCalculationInput,
  type FiscalCalculationResult,
  fiscalCalculationInputSchema,
} from '@horizon/contracts'
import { describe, expect, it, vi } from 'vitest'
import type { FiscalCalculations } from './calculations'
import { PHASE41_FIXTURE_ID } from './phase41-approved-scenario'
import { FiscalReadiness } from './readiness'

const tenantId = randomUUID()
const documentId = randomUUID()
const establishmentId = randomUUID()
const customerId = randomUUID()
const itemId = randomUUID()
const lineId = randomUUID()
const capabilityId = randomUUID()

describe('Fiscal readiness derivation', () => {
  it('derives calculation facts from frozen projections and records exact revisions', async () => {
    let derived: FiscalCalculationInput | undefined
    let readinessEvidence: Record<string, unknown> | undefined
    const calculations = {
      async preview(input: FiscalCalculationInput) {
        derived = input
        return calculationResult(input)
      },
      async validateDocument(input: {
        calculationInput: FiscalCalculationInput
        readiness?: Record<string, unknown>
      }) {
        readinessEvidence = input.readiness
        return calculationResult(input.calculationInput)
      },
    }
    const readiness = scenario(calculations)

    const first = await readiness.validate({ tenantId, documentId, actorId: 'issuer:test' })
    const retry = await readiness.validate({ tenantId, documentId, actorId: 'issuer:test' })

    expect(first).toEqual(retry)
    expect(derived).toMatchObject({
      tenantId,
      issuerEstablishmentId: establishmentId,
      issuerProfileRevision: 3,
      recipientPartyId: customerId,
      recipientProfileRevision: 7,
      operation: 'rtc-v0057-model55-normal-sale',
      issueDate: '2026-09-22',
      lines: [
        {
          id: lineId,
          itemId,
          classificationRevision: 11,
          unitPrice: '100',
          classifications: { ncm: '09012100' },
        },
      ],
    })
    expect(readinessEvidence).toMatchObject({
      capabilityId,
      issuerProfileRevision: 3,
      recipientPartyId: customerId,
      recipientProfileRevision: 7,
      classificationRevisions: { [itemId]: 11 },
      originDigest: 'a'.repeat(64),
      reconciliationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('fails closed before locking when classification or totals do not match', async () => {
    const lock = vi.fn()
    const missing = scenario(
      {
        async preview(input) {
          return calculationResult(fiscalCalculationInputSchema.parse(input))
        },
        validateDocument: lock,
      },
      { ncm: null },
    )
    await expect(
      missing.validate({ tenantId, documentId, actorId: 'issuer:test' }),
    ).resolves.toMatchObject({ supported: false, code: 'MISSING_CLASSIFICATION' })
    expect(lock).not.toHaveBeenCalled()

    const mismatch = scenario({
      async preview(input) {
        const result = calculationResult(fiscalCalculationInputSchema.parse(input))
        return { ...result, totals: { ...result.totals, gross: money('9999') } }
      },
      validateDocument: lock,
    })
    await expect(
      mismatch.validate({ tenantId, documentId, actorId: 'issuer:test' }),
    ).rejects.toThrow('does not reconcile')
    expect(lock).not.toHaveBeenCalled()
  })
})

function scenario(
  calculations: Pick<FiscalCalculations, 'preview' | 'validateDocument'>,
  classification: { ncm: string | null } = { ncm: '09012100' },
): FiscalReadiness {
  return new FiscalReadiness(
    {
      async get(requestTenant, requestedDocument) {
        if (requestTenant !== tenantId || requestedDocument !== documentId) return null
        return {
          id: documentId,
          status: 'draft',
          simulated: true,
          snapshotDigest: 'a'.repeat(64),
          model: '55',
          environment: 'simulation',
          establishmentId,
          series: 1,
          number: null,
          rootDocumentId: documentId,
          predecessorDocumentId: null,
          revision: 1,
          origin: { kind: 'sales', intentId: randomUUID() },
          accessKey: null,
          calculationDigest: null,
          signedXmlDigest: null,
          adapterVersion: null,
          schemaPackageDigest: null,
          statusUrl: `/fiscal/documents/${documentId}`,
          createdAt: '2026-09-22T15:00:00.000Z',
        }
      },
      async readSnapshot() {
        return {
          orderId: randomUUID(),
          originModule: 'sales',
          originDocumentType: 'shipment',
          originId: randomUUID(),
          purpose: 'original',
          customerId,
          lines: [
            {
              lineId,
              itemId,
              quantity: '1.000',
              description: 'Café torrado',
              unitPrice: money('10000'),
              lineTotal: money('10000'),
            },
          ],
          total: money('10000'),
        }
      },
    },
    {
      async resolveIssuer() {
        return {
          tenantId,
          revision: 3,
          effectiveFrom: '2026-01-01',
          timezone: 'America/Sao_Paulo',
          company: {
            legalName: 'Emitente Simulado LTDA',
            tradeName: null,
            taxId: '00000000E08G12',
            stateRegistration: '123456789',
            municipalRegistration: null,
            address: {
              line: 'Rua Um, 1',
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
      },
      async resolveParty() {
        return {
          tenantId,
          partyId: customerId,
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
              street: 'Rua Dois',
              number: '2',
              complement: null,
              district: 'Centro',
              city: 'São Paulo',
              municipalityCode: '3550308',
              state: 'SP',
              postalCode: '01001000',
              country: 'BR',
            },
          },
        }
      },
      async resolveClassification() {
        return {
          itemId,
          revision: 11,
          effectiveFrom: '2026-01-01',
          ncm: classification.ncm,
        }
      },
    },
    {
      async listActive() {
        return [
          {
            id: capabilityId,
            tenantId,
            model: '55',
            environment: 'simulation',
            establishmentId,
            jurisdictionKind: 'uf',
            jurisdictionCode: 'SP',
            operation: 'normal-sale',
            adapterVersion: 'nfe55-simulator-v1',
            sourceManifestDigest: '1'.repeat(64),
            schemaPackageDigest: '2'.repeat(64),
            calculationFixtureId: PHASE41_FIXTURE_ID,
            status: 'simulated',
            activatedAt: '2026-09-22T12:00:00.000Z',
            evidenceDigest: '3'.repeat(64),
          },
        ]
      },
    },
    calculations,
  )
}

function calculationResult(input: FiscalCalculationInput): FiscalCalculationResult {
  return {
    schemaVersion: 1,
    supported: true,
    inputDigest: '4'.repeat(64),
    rulesDigest: '5'.repeat(64),
    resultDigest: '6'.repeat(64),
    lines: input.lines.map((line) => ({
      lineId: line.id,
      gross: money('10000'),
      net: money('10000'),
      components: { legacy: [], ibsCbs: [] },
    })),
    totals: {
      gross: money('10000'),
      discounts: money('0'),
      charges: money('0'),
      net: money('10000'),
      legacyTax: money('0'),
      ibsCbsTax: money('0'),
    },
    reconciliation: {
      lineNetSum: money('10000'),
      legacyComponentSum: money('0'),
      ibsCbsComponentSum: money('0'),
      balanced: true,
    },
    explanation: { templateVersion: 'test-v1', text: 'Derived readiness fixture' },
  }
}

function money(amount: string) {
  return { amount, currency: 'BRL' }
}
