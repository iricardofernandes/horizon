import type { FiscalCalculationInput, FiscalCalculationOutcome } from '@horizon/contracts'
import { z } from 'zod'
import type { FiscalCalculations } from './calculations'
import { canonicalDigest } from './canonical-json'
import type { FiscalCapabilities } from './capabilities'
import {
  PHASE45_FIXTURES,
  PHASE45_SCENARIOS,
  PHASE46_FIXTURE,
  PHASE46_SCENARIO,
  supportedKind,
} from './document-kinds'
import type { FiscalDocuments } from './documents'
import { issuerRegimeOf } from './issuer-regime'
import { jurisdictionOfAddress } from './nfe55/jurisdiction'
import { type FiscalOriginSnapshot, parseFiscalOriginSnapshot } from './origin-snapshot'
import { PHASE41_FIXTURE_ID, PHASE41_SCENARIO_ID } from './phase41-approved-scenario'
import type { FiscalProjections } from './projections'

const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  actorId: z.string().min(1).max(200),
})
const drillCommandSchema = commandSchema.extend({ drillGrantId: z.uuid() })

type ReadyResult = Extract<FiscalCalculationOutcome, { supported: true }> & {
  capabilityId: string
  reconciliationDigest: string
}
type ReadyOutcome = ReadyResult | Exclude<FiscalCalculationOutcome, { supported: true }>

/** The recipient cannot receive an NFC-e: it is not a final, non-contributor consumer. */
export class ConsumerNotEligible extends Error {
  readonly code = 'CONSUMER_NOT_ELIGIBLE'
}

/** Derives readiness exclusively from the frozen Sales origin and historical projections. */
export class FiscalReadiness {
  constructor(
    private readonly documents: Pick<FiscalDocuments, 'get' | 'readSnapshot'>,
    private readonly projections: Pick<
      FiscalProjections,
      'resolveIssuer' | 'resolveParty' | 'resolveClassification'
    >,
    private readonly capabilities: Pick<FiscalCapabilities, 'listActive'> &
      Partial<Pick<FiscalCapabilities, 'getHomologationDrill'>>,
    private readonly calculations: Pick<FiscalCalculations, 'preview' | 'validateDocument'>,
  ) {}

  async validate(input: z.input<typeof commandSchema>): Promise<ReadyOutcome> {
    return this.validateInternal(commandSchema.parse(input), 'simulation')
  }

  /** Internal drill only; the public readiness route remains simulation scoped. */
  async validateHomologationDrill(
    input: z.input<typeof drillCommandSchema>,
  ): Promise<ReadyOutcome> {
    const command = drillCommandSchema.parse(input)
    return this.validateInternal(command, 'homologation', command.drillGrantId)
  }

  private async validateInternal(
    command: z.infer<typeof commandSchema>,
    environment: 'simulation' | 'homologation',
    drillGrantId?: string,
  ): Promise<ReadyOutcome> {
    const document = await this.documents.get(command.tenantId, command.documentId)
    if (!document) throw new Error('Fiscal document not found')
    if (document.status !== 'draft' && document.status !== 'ready')
      throw new Error('Fiscal document is not a draft')
    const nfce = document.model === '65'
    if (
      (document.model !== '55' && !nfce) ||
      document.environment !== environment ||
      (nfce && environment !== 'simulation')
    )
      throw new Error('Fiscal capability is unsupported')

    const snapshot = parseFiscalOriginSnapshot(
      await this.documents.readSnapshot(command.tenantId, command.documentId),
    )
    if (
      (snapshot.originModule === 'sales' && snapshot.purpose !== 'original') ||
      (snapshot.originModule === 'fiscal' && snapshot.establishmentId !== document.establishmentId)
    )
      throw new Error('Fiscal capability is unsupported')
    const manual =
      snapshot.originModule === 'fiscal' && snapshot.purpose === 'manual' ? snapshot : null
    const linked =
      snapshot.originModule === 'fiscal' && snapshot.purpose === 'linked' ? snapshot : null
    if (linked && environment !== 'simulation') throw new Error('Fiscal capability is unsupported')
    // An NFC-e is only ever a Sales consumer sale.
    if (nfce && snapshot.originModule !== 'sales')
      throw new Error('Fiscal capability is unsupported')
    const operation = nfce
      ? supportedKind('consumer-sale').operation
      : linked
        ? supportedKind(linked.kind).operation
        : 'normal-sale'
    const fixture = nfce
      ? PHASE46_FIXTURE
      : linked
        ? PHASE45_FIXTURES[linked.kind]
        : PHASE41_FIXTURE_ID

    // The establishment's registered address decides the UF; a capability only
    // applies when it was reviewed for that same jurisdiction.
    const candidates =
      environment === 'simulation'
        ? (await this.capabilities.listActive(command.tenantId)).filter(
            (candidate) =>
              candidate.model === document.model &&
              candidate.environment === 'simulation' &&
              candidate.establishmentId === document.establishmentId &&
              candidate.jurisdictionKind === 'uf' &&
              candidate.operation === operation &&
              candidate.calculationFixtureId === fixture,
          )
        : drillGrantId
          ? [
              await this.capabilities.getHomologationDrill?.(
                command.tenantId,
                command.documentId,
                drillGrantId,
              ),
            ].filter((candidate) => candidate != null)
          : []
    if (candidates.length === 0) throw new Error('Fiscal capability is unsupported')
    if (candidates.some((candidate) => candidate.establishmentId !== document.establishmentId))
      throw new Error('Fiscal capability establishment differs from document')

    const utcDate = document.createdAt.slice(0, 10)
    let issuer = await this.projections.resolveIssuer(
      command.tenantId,
      manual ? manual.issueDate : utcDate,
    )
    if (!issuer) throw new Error('Issuer fiscal projection is unavailable')
    const issueDate = manual ? manual.issueDate : localDate(document.createdAt, issuer.timezone)
    if (!manual && issueDate !== utcDate)
      issuer = (await this.projections.resolveIssuer(command.tenantId, issueDate)) ?? issuer
    if (manual && issuer.revision !== manual.issuerProfileRevision)
      throw new Error('Fiscal manual issuer revision is no longer effective')
    const jurisdiction = jurisdictionOfAddress(issuer.company.address)
    const capability = candidates.find(
      (candidate) => candidate.jurisdictionCode === jurisdiction?.uf,
    )
    if (!jurisdiction || !capability) throw new Error('Fiscal capability is unsupported')
    const recipient = await this.projections.resolveParty(
      command.tenantId,
      snapshot.customerId,
      issueDate,
    )
    if (!recipient) throw new Error('Recipient fiscal projection is unavailable')
    if (manual && recipient.revision !== manual.recipientProfileRevision)
      throw new Error('Fiscal manual recipient revision is no longer effective')
    if (
      nfce &&
      (!recipient.profile.finalConsumer ||
        recipient.profile.taxpayerIndicator !== 'non-contributor')
    )
      throw new ConsumerNotEligible(
        'An NFC-e needs a final consumer who is not an ICMS contributor; issue an NF-e instead',
      )

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
      if ('catalogRevision' in line && classification.revision !== line.catalogRevision)
        throw new Error('Fiscal manual classification revision is no longer effective')
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
      environment,
      model: nfce ? '65' : '55',
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
    if (locked.resultDigest !== preview.resultDigest || locked.rulesDigest !== preview.rulesDigest)
      throw new Error('Fiscal rules changed between preview and readiness binding')
    return { ...locked, capabilityId: capability.id, reconciliationDigest: reconciliation }
  }
}

export function deriveCalculationInput(input: {
  tenantId: string
  establishmentId: string
  issueDate: string
  issuer: NonNullable<Awaited<ReturnType<FiscalProjections['resolveIssuer']>>>
  recipient: NonNullable<Awaited<ReturnType<FiscalProjections['resolveParty']>>>
  snapshot: FiscalOriginSnapshot
  classifications: Map<
    string,
    NonNullable<Awaited<ReturnType<FiscalProjections['resolveClassification']>>>
  >
  environment: 'simulation' | 'homologation'
  model: '55' | '65'
}): FiscalCalculationInput {
  const issuerAddress = input.issuer.company.address
  const recipientAddress = input.recipient.profile.address
  const regime = issuerRegimeOf(input.issuer.company.fiscalRegime)
  // Issuing for a Simples or MEI issuer (CSOSN) is not built; its calculation is previewable.
  if (regime?.regime !== 'normal') throw new Error('Fiscal capability is unsupported')
  const issuer = jurisdictionOfAddress(issuerAddress)
  const recipient = jurisdictionOfAddress(recipientAddress)
  // The normal-sale operation is intrastate (`idDest` 1); interstate sales need their
  // own reviewed operation.
  if (!issuer || !recipient || issuer.uf !== recipient.uf)
    throw new Error('Fiscal capability is unsupported')
  if (input.snapshot.total.currency !== 'BRL') throw new Error('Fiscal capability is unsupported')
  const linked =
    input.snapshot.originModule === 'fiscal' && input.snapshot.purpose === 'linked'
      ? input.snapshot
      : null
  const reference = linked?.references[0]
  const linkedFacts = linked
    ? {
        operation: PHASE45_SCENARIOS[linked.kind],
        purpose:
          linked.kind === 'value-complement' ? ('complementary' as const) : ('return' as const),
        referencedDocumentId:
          reference?.type === 'document' ? reference.documentId : reference?.importId,
      }
    : null

  return {
    schemaVersion: 1,
    tenantId: input.tenantId,
    issuerEstablishmentId: input.establishmentId,
    issuerProfileRevision: input.issuer.revision,
    recipientPartyId: input.recipient.partyId,
    recipientProfileRevision: input.recipient.revision,
    model: input.model,
    environment: input.environment,
    operation:
      linkedFacts?.operation ?? (input.model === '65' ? PHASE46_SCENARIO : PHASE41_SCENARIO_ID),
    purpose: linkedFacts?.purpose ?? 'normal',
    ...(linkedFacts?.referencedDocumentId
      ? { referencedDocumentId: linkedFacts.referencedDocumentId }
      : {}),
    issuer: {
      ...regime,
      stateCode: issuer.ufCode,
      municipalityCode: issuer.municipalityCode,
    },
    recipient: {
      regime: input.model === '65' ? 'final-consumer' : 'normal',
      stateCode: recipient.ufCode,
      municipalityCode: recipient.municipalityCode,
      taxpayer: input.recipient.profile.taxpayerIndicator === 'contributor',
    },
    origin: {
      countryCode: '1058',
      stateCode: issuer.ufCode,
      municipalityCode: issuer.municipalityCode,
    },
    destination: {
      countryCode: '1058',
      stateCode: recipient.ufCode,
      municipalityCode: recipient.municipalityCode,
    },
    issueDate: input.issueDate,
    currency: 'BRL',
    lines: input.snapshot.lines.map((line) => {
      if (line.unitPrice.currency !== 'BRL' || line.lineTotal.currency !== 'BRL')
        throw new Error('Fiscal capability is unsupported')
      const classification = input.classifications.get(line.itemId)
      if (!classification?.ncm) throw new Error('Catalog classification is unavailable')
      const complement = linkedFacts?.purpose === 'complementary'
      return {
        id: line.lineId,
        itemId: line.itemId,
        classificationRevision: classification.revision,
        quantity: complement ? '0' : canonicalDecimal(line.quantity),
        unitPrice: complement ? '0' : minorUnitsToDecimal(line.unitPrice.amount, 2),
        ...(complement ? { complementValue: minorUnitsToDecimal(line.lineTotal.amount, 2) } : {}),
        discount: { amount: '0', currency: 'BRL' },
        charges: { amount: '0', currency: 'BRL' },
        classifications: { ncm: classification.ncm },
        taxFacts: {},
      }
    }),
  }
}

function reconcileCommercial(
  snapshot: FiscalOriginSnapshot,
  result: Extract<FiscalCalculationOutcome, { supported: true }>,
): string {
  const expectedLines = new Map(snapshot.lines.map((line) => [line.lineId, line.lineTotal.amount]))
  if (result.lines.length !== expectedLines.size)
    throw new Error('Fiscal calculation does not reconcile with the commercial origin')
  // A return is calculated as a reversal (negative); the commercial origin holds magnitudes.
  const magnitude = (amount: string) => amount.replace(/^-/, '')
  for (const line of result.lines)
    if (
      line.gross.currency !== snapshot.total.currency ||
      magnitude(line.gross.amount) !== expectedLines.get(line.lineId)
    )
      throw new Error('Fiscal calculation does not reconcile with the commercial origin')
  if (
    result.totals.gross.currency !== snapshot.total.currency ||
    magnitude(result.totals.gross.amount) !== snapshot.total.amount
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
