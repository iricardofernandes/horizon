import type { FiscalCalculationInput, FiscalCalculationOutcome } from '@horizon/contracts'
import { z } from 'zod'
import type { FiscalCalculations } from '../calculations'
import { canonicalDigest } from '../canonical-json'
import type { FiscalCapabilities } from '../capabilities'
import type { FiscalDocuments } from '../documents'
import { jurisdictionOfAddress } from '../nfe55/jurisdiction'
import { PHASE47_FIXTURE, phase47Scenario } from '../phase47-approved-scenario'
import type { FiscalProjections } from '../projections'
import { MunicipalityUnsupported, ServiceProfileMissing } from './errors'
import type { FiscalNfseRegistry } from './registry'
import {
  assertIssuer,
  assertRecipient,
  NFSE_OPERATION,
  type ServiceOriginPayload,
  serviceOriginPayloadSchema,
} from './service-origins'
import type { FiscalServiceProfiles } from './service-profiles'

const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  actorId: z.string().min(1).max(200),
})

type ReadyResult = Extract<FiscalCalculationOutcome, { supported: true }> & {
  capabilityId: string
  reconciliationDigest: string
}

/**
 * Makes an NFS-e draft ready: the municipality must be issued by the national system on
 * the competence date, the capability must be that municipality's, and the service
 * profile revision frozen by the origin must still be in force.
 */
export class FiscalServiceReadiness {
  constructor(
    private readonly documents: Pick<FiscalDocuments, 'get' | 'readSnapshot'>,
    private readonly projections: Pick<FiscalProjections, 'resolveIssuer' | 'resolveParty'>,
    private readonly capabilities: Pick<FiscalCapabilities, 'listActive'>,
    private readonly profiles: Pick<FiscalServiceProfiles, 'effective'>,
    private readonly registry: Pick<FiscalNfseRegistry, 'resolve'>,
    private readonly calculations: Pick<FiscalCalculations, 'preview' | 'validateDocument'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async validate(
    input: z.input<typeof commandSchema>,
  ): Promise<ReadyResult | Exclude<FiscalCalculationOutcome, { supported: true }>> {
    const command = commandSchema.parse(input)
    const document = await this.documents.get(command.tenantId, command.documentId)
    if (!document) throw new Error('Fiscal document not found')
    if (document.model !== 'nfse' || document.environment !== 'simulation')
      throw new Error('Fiscal capability is unsupported')
    if (document.status !== 'draft' && document.status !== 'ready')
      throw new Error('Fiscal document is not a draft')
    const origin = serviceOriginPayloadSchema.parse(
      await this.documents.readSnapshot(command.tenantId, command.documentId),
    )
    if (origin.establishmentId !== document.establishmentId)
      throw new Error('Fiscal capability is unsupported')

    const probe = await this.projections.resolveIssuer(
      command.tenantId,
      this.now().toISOString().slice(0, 10),
    )
    if (!probe) throw new Error('Issuer fiscal projection is unavailable')
    const issueDate = localDate(this.now(), probe.timezone)
    const current = await this.projections.resolveIssuer(command.tenantId, issueDate)
    if (current?.revision !== origin.issuerProfileRevision)
      throw new Error('Fiscal service issuer revision is no longer effective')
    const municipalityCode = assertIssuer(current)
    if (municipalityCode !== origin.municipalityCode)
      throw new MunicipalityUnsupported('The issuer municipality changed after the origin froze')
    const resolution = await this.registry.resolve(
      command.tenantId,
      municipalityCode,
      origin.competenceDate,
    )
    if (resolution.route !== 'national')
      throw new MunicipalityUnsupported(resolution.reason ?? 'Municipality is unsupported')
    const capability = (await this.capabilities.listActive(command.tenantId)).find(
      (row) =>
        row.model === 'nfse' &&
        row.environment === 'simulation' &&
        row.establishmentId === document.establishmentId &&
        row.jurisdictionKind === 'municipality' &&
        row.jurisdictionCode === municipalityCode &&
        row.operation === NFSE_OPERATION &&
        row.calculationFixtureId === PHASE47_FIXTURE,
    )
    if (!capability) throw new Error('Fiscal capability is unsupported')

    const recipient = await this.projections.resolveParty(
      command.tenantId,
      origin.customerId,
      issueDate,
    )
    if (!recipient) throw new Error('Recipient fiscal projection is unavailable')
    if (recipient.revision !== origin.recipientProfileRevision)
      throw new Error('Fiscal service recipient revision is no longer effective')
    assertRecipient(recipient)
    const profile = await this.profiles.effective(
      command.tenantId,
      origin.serviceItemId,
      origin.competenceDate,
    )
    if (profile?.revision !== origin.serviceProfileRevision)
      throw new ServiceProfileMissing(
        'The service profile revision frozen by the origin is no longer in force',
      )

    const calculationInput = serviceCalculationInput({
      tenantId: command.tenantId,
      origin,
      issuer: current,
      recipient,
      issueDate,
    })
    const preview = await this.calculations.preview(calculationInput)
    if (!preview.supported) return preview
    const reconciliation = reconcileService(origin, preview)
    const locked = await this.calculations.validateDocument({
      ...command,
      calculationInput,
      readiness: {
        capabilityId: capability.id,
        issuerProfileRevision: current.revision,
        recipientPartyId: recipient.partyId,
        recipientProfileRevision: recipient.revision,
        classificationRevisions: { [origin.serviceItemId]: origin.serviceProfileRevision },
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

/** One service line, classified by its national tax code, selected by competence. */
export function serviceCalculationInput(input: {
  tenantId: string
  origin: ServiceOriginPayload
  issuer: NonNullable<Awaited<ReturnType<FiscalProjections['resolveIssuer']>>>
  recipient: NonNullable<Awaited<ReturnType<FiscalProjections['resolveParty']>>>
  issueDate: string
}): FiscalCalculationInput {
  const issuer = jurisdictionOfAddress(input.issuer.company.address)
  const recipient = jurisdictionOfAddress(input.recipient.profile.address)
  if (!issuer || !recipient) throw new Error('Fiscal capability is unsupported')
  return {
    schemaVersion: 1,
    tenantId: input.tenantId,
    issuerEstablishmentId: input.origin.establishmentId,
    issuerProfileRevision: input.issuer.revision,
    recipientPartyId: input.recipient.partyId,
    recipientProfileRevision: input.recipient.revision,
    model: 'nfse',
    environment: 'simulation',
    operation: phase47Scenario(input.origin.municipalityCode),
    purpose: 'normal',
    issuer: {
      regime: 'normal',
      stateCode: issuer.ufCode,
      municipalityCode: issuer.municipalityCode,
    },
    recipient: {
      regime: 'normal',
      stateCode: recipient.ufCode,
      municipalityCode: recipient.municipalityCode,
      taxpayer: input.recipient.profile.taxpayerIndicator === 'contributor',
    },
    // The service is provided at the issuer's establishment (`cLocPrestacao`).
    origin: {
      countryCode: '1058',
      stateCode: issuer.ufCode,
      municipalityCode: issuer.municipalityCode,
    },
    destination: {
      countryCode: '1058',
      stateCode: issuer.ufCode,
      municipalityCode: issuer.municipalityCode,
    },
    issueDate: input.issueDate,
    competenceDate: input.origin.competenceDate,
    currency: 'BRL',
    lines: [
      {
        id: input.origin.lineId,
        serviceId: input.origin.serviceItemId,
        classificationRevision: input.origin.serviceProfileRevision,
        quantity: '1',
        unitPrice: minorToDecimal(input.origin.amount.amount),
        discount: { amount: '0', currency: 'BRL' },
        charges: { amount: '0', currency: 'BRL' },
        classifications: { service: input.origin.nationalTaxCode },
        taxFacts: { nbs: input.origin.nbsCode },
      },
    ],
  }
}

function reconcileService(
  origin: ServiceOriginPayload,
  result: Extract<FiscalCalculationOutcome, { supported: true }>,
): string {
  const [line] = result.lines
  if (
    result.lines.length !== 1 ||
    line?.lineId !== origin.lineId ||
    line.gross.amount !== origin.amount.amount ||
    result.totals.gross.amount !== origin.amount.amount ||
    !line.components.legacy.some((component) => component.code === 'ISS')
  )
    throw new Error('Fiscal calculation does not reconcile with the service origin')
  return canonicalDigest({
    toleranceMinorUnits: '0',
    originTotal: origin.amount,
    calculatedGross: result.totals.gross,
    lines: [[origin.lineId, origin.amount.amount]],
  })
}

function minorToDecimal(value: string): string {
  const padded = value.padStart(3, '0')
  const integer = padded.slice(0, -2).replace(/^0+(?=\d)/, '')
  const fraction = padded.slice(-2).replace(/0+$/, '')
  return fraction ? `${integer}.${fraction}` : integer
}

export function localDate(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((member) => member.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}
