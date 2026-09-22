import {
  type FiscalCalculationInput,
  type FiscalCalculationOutcome,
  salesFiscalOriginRecorded,
} from '@horizon/contracts'
import { z } from 'zod'
import type { FiscalCalculations } from './calculations'
import { canonicalDigest } from './canonical-json'
import type { FiscalCapabilities } from './capabilities'
import type { FiscalDocuments } from './documents'
import { PHASE41_FIXTURE_ID, PHASE41_SCENARIO_ID } from './phase41-approved-scenario'
import type { FiscalProjections } from './projections'

const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  actorId: z.string().min(1).max(200),
})

type ReadyResult = Extract<FiscalCalculationOutcome, { supported: true }> & {
  capabilityId: string
  reconciliationDigest: string
}
type ReadyOutcome = ReadyResult | Exclude<FiscalCalculationOutcome, { supported: true }>

/** Derives readiness exclusively from the frozen Sales origin and historical projections. */
export class FiscalReadiness {
  constructor(
    private readonly documents: Pick<FiscalDocuments, 'get' | 'readSnapshot'>,
    private readonly projections: Pick<
      FiscalProjections,
      'resolveIssuer' | 'resolveParty' | 'resolveClassification'
    >,
    private readonly capabilities: Pick<FiscalCapabilities, 'listActive'>,
    private readonly calculations: Pick<FiscalCalculations, 'preview' | 'validateDocument'>,
  ) {}

  async validate(input: z.input<typeof commandSchema>): Promise<ReadyOutcome> {
    const command = commandSchema.parse(input)
    const document = await this.documents.get(command.tenantId, command.documentId)
    if (!document) throw new Error('Fiscal document not found')
    if (document.status !== 'draft' && document.status !== 'ready')
      throw new Error('Fiscal document is not a draft')
    if (document.model !== '55' || document.environment !== 'simulation')
      throw new Error('Fiscal capability is unsupported')

    const snapshot = salesFiscalOriginRecorded.payload.parse(
      await this.documents.readSnapshot(command.tenantId, command.documentId),
    )
    if (snapshot.purpose !== 'original') throw new Error('Fiscal capability is unsupported')

    const capabilities = await this.capabilities.listActive(command.tenantId)
    const capability = capabilities.find(
      (candidate) =>
        candidate.model === '55' &&
        candidate.environment === 'simulation' &&
        candidate.establishmentId === document.establishmentId &&
        candidate.jurisdictionKind === 'uf' &&
        candidate.jurisdictionCode === 'SP' &&
        candidate.operation === 'normal-sale' &&
        candidate.calculationFixtureId === PHASE41_FIXTURE_ID,
    )
    if (!capability) throw new Error('Fiscal capability is unsupported')

    const utcDate = document.createdAt.slice(0, 10)
    let issuer = await this.projections.resolveIssuer(command.tenantId, utcDate)
    if (!issuer) throw new Error('Issuer fiscal projection is unavailable')
    const issueDate = localDate(document.createdAt, issuer.timezone)
    if (issueDate !== utcDate)
      issuer = (await this.projections.resolveIssuer(command.tenantId, issueDate)) ?? issuer
    const recipient = await this.projections.resolveParty(
      command.tenantId,
      snapshot.customerId,
      issueDate,
    )
    if (!recipient) throw new Error('Recipient fiscal projection is unavailable')

    const classifications = new Map<
      string,
      NonNullable<Awaited<ReturnType<FiscalProjections['resolveClassification']>>>
    >()
    for (const line of snapshot.lines) {
      const classification = await this.projections.resolveClassification(
        command.tenantId,
        line.itemId,
        issueDate,
      )
      if (!classification?.ncm)
        return unsupported('MISSING_CLASSIFICATION', `NCM is unavailable for item ${line.itemId}`)
      classifications.set(line.itemId, classification)
    }

    const calculationInput = deriveCalculationInput({
      tenantId: command.tenantId,
      establishmentId: document.establishmentId,
      issueDate,
      issuer,
      recipient,
      snapshot,
      classifications,
    })
    const preview = await this.calculations.preview(calculationInput)
    if (!preview.supported) return preview
    const reconciliation = reconcileCommercial(snapshot, preview)

    const locked = await this.calculations.validateDocument({
      ...command,
      calculationInput,
      readiness: {
        capabilityId: capability.id,
        issuerProfileRevision: issuer.revision,
        recipientPartyId: recipient.partyId,
        recipientProfileRevision: recipient.revision,
        classificationRevisions: Object.fromEntries(
          [...classifications].map(([itemId, classification]) => [itemId, classification.revision]),
        ),
        originDigest: document.snapshotDigest,
        reconciliationDigest: reconciliation,
      },
    })
    if (!locked.supported) return locked
    return { ...locked, capabilityId: capability.id, reconciliationDigest: reconciliation }
  }
}

function deriveCalculationInput(input: {
  tenantId: string
  establishmentId: string
  issueDate: string
  issuer: NonNullable<Awaited<ReturnType<FiscalProjections['resolveIssuer']>>>
  recipient: NonNullable<Awaited<ReturnType<FiscalProjections['resolveParty']>>>
  snapshot: ReturnType<typeof salesFiscalOriginRecorded.payload.parse>
  classifications: Map<
    string,
    NonNullable<Awaited<ReturnType<FiscalProjections['resolveClassification']>>>
  >
}): FiscalCalculationInput {
  const issuerAddress = input.issuer.company.address
  const recipientAddress = input.recipient.profile.address
  if (
    input.issuer.company.fiscalRegime !== 'lucro-real' &&
    input.issuer.company.fiscalRegime !== 'lucro-presumido'
  )
    throw new Error('Fiscal capability is unsupported')
  if (
    issuerAddress.state !== 'SP' ||
    recipientAddress.state !== 'SP' ||
    !issuerAddress.municipalityCode ||
    !recipientAddress.municipalityCode
  )
    throw new Error('Fiscal capability is unsupported')
  if (input.snapshot.total.currency !== 'BRL') throw new Error('Fiscal capability is unsupported')

  return {
    schemaVersion: 1,
    tenantId: input.tenantId,
    issuerEstablishmentId: input.establishmentId,
    issuerProfileRevision: input.issuer.revision,
    recipientPartyId: input.recipient.partyId,
    recipientProfileRevision: input.recipient.revision,
    model: '55',
    environment: 'simulation',
    operation: PHASE41_SCENARIO_ID,
    purpose: 'normal',
    issuer: { regime: 'normal', stateCode: '35', municipalityCode: issuerAddress.municipalityCode },
    recipient: {
      regime: 'normal',
      stateCode: '35',
      municipalityCode: recipientAddress.municipalityCode,
      taxpayer: input.recipient.profile.taxpayerIndicator === 'contributor',
    },
    origin: {
      countryCode: '1058',
      stateCode: '35',
      municipalityCode: issuerAddress.municipalityCode,
    },
    destination: {
      countryCode: '1058',
      stateCode: '35',
      municipalityCode: recipientAddress.municipalityCode,
    },
    issueDate: input.issueDate,
    currency: 'BRL',
    lines: input.snapshot.lines.map((line) => {
      if (line.unitPrice.currency !== 'BRL' || line.lineTotal.currency !== 'BRL')
        throw new Error('Fiscal capability is unsupported')
      const classification = input.classifications.get(line.itemId)
      if (!classification?.ncm) throw new Error('Catalog classification is unavailable')
      return {
        id: line.lineId,
        itemId: line.itemId,
        classificationRevision: classification.revision,
        quantity: canonicalDecimal(line.quantity),
        unitPrice: minorUnitsToDecimal(line.unitPrice.amount, 2),
        discount: { amount: '0', currency: 'BRL' },
        charges: { amount: '0', currency: 'BRL' },
        classifications: { ncm: classification.ncm },
        taxFacts: {},
      }
    }),
  }
}

function reconcileCommercial(
  snapshot: ReturnType<typeof salesFiscalOriginRecorded.payload.parse>,
  result: Extract<FiscalCalculationOutcome, { supported: true }>,
): string {
  const expectedLines = new Map(snapshot.lines.map((line) => [line.lineId, line.lineTotal.amount]))
  if (result.lines.length !== expectedLines.size)
    throw new Error('Fiscal calculation does not reconcile with the commercial origin')
  for (const line of result.lines)
    if (
      line.gross.currency !== snapshot.total.currency ||
      line.gross.amount !== expectedLines.get(line.lineId)
    )
      throw new Error('Fiscal calculation does not reconcile with the commercial origin')
  if (
    result.totals.gross.currency !== snapshot.total.currency ||
    result.totals.gross.amount !== snapshot.total.amount
  )
    throw new Error('Fiscal calculation does not reconcile with the commercial origin')
  return canonicalDigest({
    toleranceMinorUnits: '0',
    originTotal: snapshot.total,
    calculatedGross: result.totals.gross,
    lines: [...expectedLines].sort(([left], [right]) => left.localeCompare(right)),
  })
}

function minorUnitsToDecimal(value: string, scale: number): string {
  if (!/^\d+$/.test(value)) throw new Error('Commercial money must be non-negative')
  const padded = value.padStart(scale + 1, '0')
  const integer = padded.slice(0, -scale).replace(/^0+(?=\d)/, '')
  const fraction = padded.slice(-scale).replace(/0+$/, '')
  return fraction ? `${integer}.${fraction}` : integer
}

function canonicalDecimal(value: string): string {
  const [integer = '0', fraction = ''] = value.split('.')
  const normalizedInteger = integer.replace(/^0+(?=\d)/, '')
  const normalizedFraction = fraction.replace(/0+$/, '')
  return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger
}

function localDate(instant: string, timezone: string): string {
  const members = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    members.find((member) => member.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function unsupported(
  code: 'MISSING_CLASSIFICATION',
  detail: string,
): Exclude<FiscalCalculationOutcome, { supported: true }> {
  return { schemaVersion: 1, supported: false, code, detail }
}
