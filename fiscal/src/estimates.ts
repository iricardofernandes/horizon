import { randomUUID } from 'node:crypto'
import {
  FISCAL_TAXES_CHARGED_ON_TOP,
  type FiscalCalculationInput,
  type FiscalCalculationOutcome,
  type FiscalTaxEstimate,
  type FiscalTaxEstimateRequest,
  type FiscalTaxSupportMatrix,
  fiscalTaxEstimateRequestSchema,
  fiscalTaxEstimateSchema,
  salesFiscalOriginRecorded,
} from '@horizon/contracts'
import type { FiscalCalculations } from './calculations'
import { decimal, multiply, roundHalfAwayFromZero } from './exact-decimal'
import { jurisdictionOfAddress } from './nfe55/jurisdiction'
import { PHASE41_SCENARIO_ID } from './phase41-approved-scenario'
import type { FiscalProjections } from './projections'
import { deriveCalculationInput } from './readiness'
import { measured } from './tax-metrics'
import { scenarioSupport } from './tax-support'
import { SUPPORT_MATRIX } from './tax-support-api'

/**
 * Tax estimates (Phase 87, ADR 0073): Fiscal's calculation of a commercial draft, never
 * locked and never transmitted. A sale is derived exactly as readiness derives a shipment, so
 * the estimate and the later lock agree; a purchase takes the supplier's regime from the
 * caller, because Fiscal never infers a treatment it was not given.
 */
export class FiscalEstimates {
  constructor(
    private readonly projections: Pick<
      FiscalProjections,
      'resolveIssuer' | 'resolveParty' | 'resolveClassification'
    >,
    private readonly calculations: Pick<FiscalCalculations, 'preview'>,
    private readonly supportMatrix: FiscalTaxSupportMatrix = SUPPORT_MATRIX,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Timed and counted with the other calculations (Phase 89). */
  estimate(tenantId: string, candidate: unknown): Promise<FiscalTaxEstimate> {
    return measured('estimate', () => this.estimateOnce(tenantId, candidate))
  }

  private async estimateOnce(tenantId: string, candidate: unknown): Promise<FiscalTaxEstimate> {
    const request = fiscalTaxEstimateRequestSchema.parse(candidate)
    const estimatedAt = this.now().toISOString()
    const refused = (code: string, detail: string, missingDimension?: string): FiscalTaxEstimate =>
      fiscalTaxEstimateSchema.parse({
        schemaVersion: 1,
        supported: false,
        estimatedAt,
        code,
        detail,
        ...(missingDimension ? { missingDimension } : {}),
      })
    let input: FiscalCalculationInput
    try {
      const built = await this.input(tenantId, request)
      if ('refused' in built) return refused(built.refused, built.detail, built.missingDimension)
      input = built
    } catch (error) {
      return refused(
        'UNSUPPORTED_RULE',
        error instanceof Error ? error.message : 'The draft cannot be calculated',
      )
    }
    const outcome = await this.calculations.preview(input)
    if (!outcome.supported)
      return refused(outcome.code, outcome.detail, outcome.missingDimension ?? undefined)
    // What cannot be issued is not estimated as if it could (ADR 0072).
    const support = scenarioSupport(this.supportMatrix, input, outcome)
    if (!support.supported)
      return refused('UNSUPPORTED_SCENARIO', support.detail, support.missingDimension)
    return summary(outcome, estimatedAt)
  }

  private async input(
    tenantId: string,
    request: FiscalTaxEstimateRequest,
  ): Promise<
    FiscalCalculationInput | { refused: string; detail: string; missingDimension?: string }
  > {
    const ours = await this.projections.resolveIssuer(tenantId, request.issueDate)
    if (!ours)
      return { refused: 'INVALID_FISCAL_INPUT', detail: 'The workspace has no fiscal profile' }
    const partyId = request.direction === 'sale' ? request.customerPartyId : request.supplierPartyId
    const party = await this.projections.resolveParty(tenantId, partyId, request.issueDate)
    if (!party)
      return { refused: 'INVALID_FISCAL_INPUT', detail: 'The party has no fiscal profile' }
    const classifications = new Map<
      string,
      NonNullable<Awaited<ReturnType<FiscalProjections['resolveClassification']>>>
    >()
    for (const line of request.lines) {
      const found = await this.projections.resolveClassification(
        tenantId,
        line.itemId,
        request.issueDate,
      )
      if (!found?.ncm)
        return {
          refused: 'MISSING_CLASSIFICATION',
          detail: `NCM is unavailable for item ${line.itemId}`,
          missingDimension: line.itemId,
        }
      classifications.set(line.itemId, found)
    }
    const lineIds = request.lines.map(() => randomUUID())
    const stated = (base: FiscalCalculationInput) => ({
      ...base,
      lines: base.lines.map((line, index) => {
        const draft = request.lines[index]
        return {
          ...line,
          ...(draft?.discount ? { discount: draft.discount } : {}),
          classifications: {
            ...line.classifications,
            ...(draft?.classTrib ? { classTrib: draft.classTrib } : {}),
          },
          // What the draft states adds to what the parties and items state (Phase 89).
          taxFacts: { ...line.taxFacts, ...(draft?.facts ?? {}) },
        }
      }),
    })
    if (request.direction === 'sale') {
      const lines = request.lines.map((line, index) => ({
        lineId: lineIds[index] ?? randomUUID(),
        itemId: line.itemId,
        quantity: line.quantity,
        description: 'estimate',
        unitPrice: line.unitPrice,
        lineTotal: {
          amount: String(
            roundHalfAwayFromZero(multiply(decimal(line.quantity), decimal(line.unitPrice.amount))),
          ),
          currency: line.unitPrice.currency,
        },
      }))
      // A commercial draft as readiness would receive it from Sales, so the derivation is one.
      const snapshot = salesFiscalOriginRecorded.payload.parse({
        orderId: randomUUID(),
        originModule: 'sales',
        originDocumentType: 'shipment',
        originId: randomUUID(),
        purpose: 'original',
        customerId: partyId,
        lines,
        total: {
          amount: String(lines.reduce((sum, line) => sum + BigInt(line.lineTotal.amount), 0n)),
          currency: lines[0]?.unitPrice.currency ?? 'BRL',
        },
      })
      return stated(
        deriveCalculationInput({
          tenantId,
          establishmentId: request.establishmentId,
          issueDate: request.issueDate,
          issuer: ours,
          recipient: party,
          snapshot,
          classifications,
          environment: 'simulation',
          model: '55',
        }),
      )
    }
    const supplier = jurisdictionOfAddress(party.profile.address)
    const workspace = jurisdictionOfAddress(ours.company.address)
    if (!supplier || !workspace)
      return { refused: 'INVALID_FISCAL_INPUT', detail: 'An address has no IBGE municipality' }
    return stated({
      schemaVersion: 1,
      tenantId,
      issuerEstablishmentId: request.establishmentId,
      model: '55',
      environment: 'simulation',
      // The supplier's sale is the reviewed normal sale readiness derives for ours.
      operation: PHASE41_SCENARIO_ID,
      purpose: 'normal',
      // The supplier issues: its regime is the caller's statement, not Fiscal's guess.
      issuer: {
        ...request.supplier,
        stateCode: supplier.ufCode,
        municipalityCode: supplier.municipalityCode,
      },
      recipient: {
        regime: ours.company.fiscalRegime === 'simples-nacional' ? 'simples-nacional' : 'normal',
        stateCode: workspace.ufCode,
        municipalityCode: workspace.municipalityCode,
        taxpayer: Boolean(ours.company.stateRegistration),
      },
      origin: {
        countryCode: '1058',
        stateCode: supplier.ufCode,
        municipalityCode: supplier.municipalityCode,
      },
      destination: {
        countryCode: '1058',
        stateCode: workspace.ufCode,
        municipalityCode: workspace.municipalityCode,
      },
      issueDate: request.issueDate,
      currency: 'BRL',
      lines: request.lines.map((line, index) => ({
        id: lineIds[index] ?? randomUUID(),
        itemId: line.itemId,
        quantity: line.quantity,
        unitPrice: minorToDecimal(line.unitPrice.amount),
        discount: { amount: '0', currency: 'BRL' },
        charges: { amount: '0', currency: 'BRL' },
        classifications: { ncm: classifications.get(line.itemId)?.ncm ?? '' },
        taxFacts: {},
      })),
    })
  }
}

function minorToDecimal(amount: string): string {
  const padded = amount.padStart(3, '0')
  const whole = padded.slice(0, -2).replace(/^0+(?=\d)/, '')
  const cents = padded.slice(-2).replace(/0+$/, '')
  return cents ? `${whole}.${cents}` : whole
}

/** The estimate as Sales and Procurement keep it: components, totals and digests. */
function summary(
  outcome: Extract<FiscalCalculationOutcome, { supported: true }>,
  estimatedAt: string,
): FiscalTaxEstimate {
  const currency = outcome.totals.net.currency
  const components = outcome.lines.flatMap((line) =>
    (['legacy', 'ibsCbs'] as const).flatMap((group) =>
      line.components[group].map((component) => ({
        group,
        code: component.code,
        amount: component.amount,
        outcome: component.outcome ?? ('levied' as const),
      })),
    ),
  )
  // One entry per component across the lines, as a record keeps it.
  const merged = new Map<string, (typeof components)[number]>()
  for (const component of components) {
    const key = `${component.group}:${component.code}:${component.outcome}`
    const held = merged.get(key)
    merged.set(key, {
      ...component,
      amount: {
        amount: String(BigInt(held?.amount.amount ?? '0') + BigInt(component.amount.amount)),
        currency,
      },
    })
  }
  const sum = (codes?: readonly string[]) =>
    [...merged.values()]
      .filter((component) => component.outcome === 'levied')
      .filter((component) => !codes || codes.includes(component.code))
      .reduce((total, component) => total + BigInt(component.amount.amount), 0n)
  const chargedOnTop = sum(FISCAL_TAXES_CHARGED_ON_TOP)
  return fiscalTaxEstimateSchema.parse({
    schemaVersion: 1,
    supported: true,
    estimatedAt,
    components: [...merged.values()].sort((left, right) =>
      `${left.group}:${left.code}`.localeCompare(`${right.group}:${right.code}`),
    ),
    totals: {
      net: outcome.totals.net,
      tax: { amount: String(sum()), currency },
      chargedOnTop: { amount: String(chargedOnTop), currency },
      gross: { amount: String(BigInt(outcome.totals.net.amount) + chargedOnTop), currency },
    },
    inputDigest: outcome.inputDigest,
    rulesDigest: outcome.rulesDigest,
    resultDigest: outcome.resultDigest,
  })
}
