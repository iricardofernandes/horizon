import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalArtifacts } from './artifacts'
import type { FiscalCalculations } from './calculations'
import { canonicalDigest } from './canonical-json'
import type { FiscalDispatch } from './dispatch'
import type { FiscalDocuments } from './documents'
import { buildNfce65Data } from './nfce65/build'
import { renderSimulatedDanfeNfce } from './nfce65/danfe'
import { signNfce65 } from './nfce65/signature'
import { serializeNfce65 } from './nfce65/xml'
import { nfeLines, nfeTotals } from './nfe-lines'
import { deterministicNumericCode, digits, zonedInstant } from './nfe-values'
import { buildNfe55AccessKey } from './nfe55/access-key'
import { renderSimulatedDanfe } from './nfe55/danfe'
import { type Nfe55IssuanceProfile, nfe55IssuanceProfileSchema } from './nfe55/issuance-profile'
import type { Nfe55Data } from './nfe55/model'
import { validateNfe55Schema } from './nfe55/schema'
import { type SimulationCredential, signNfe55, verifyNfe55Signature } from './nfe55/signature'
import { serializeNfe55 } from './nfe55/xml'
import { type FiscalOriginSnapshot, parseFiscalOriginSnapshot } from './origin-snapshot'
import type { FiscalProjections } from './projections'

const digest = z.string().regex(/^[0-9a-f]{64}$/)
const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  idempotencyKey: z.string().min(16).max(128),
  actorId: z.string().min(1).max(200),
})
export type Nfe55SimulationProfile = Nfe55IssuanceProfile

type IssuanceFacts = {
  document: NonNullable<Awaited<ReturnType<FiscalDocuments['get']>>>
  number: number
  issuer: NonNullable<Awaited<ReturnType<FiscalProjections['readIssuer']>>>
  recipient: NonNullable<Awaited<ReturnType<FiscalProjections['readParty']>>>
  calculation: NonNullable<Awaited<ReturnType<FiscalCalculations['readFrozen']>>>
  origin: FiscalOriginSnapshot
}

type Prepared = {
  accessKey: string
  unsigned: Buffer
  signed: Buffer
  danfe: Buffer
  danfeSchema: string
}

/** Prepares exact signed bytes and only then crosses the durable dispatch boundary. */
export class FiscalIssuance {
  readonly #db: ReturnType<typeof postgres>
  readonly #profile: Nfe55SimulationProfile

  constructor(
    databaseUrl: string,
    private readonly documents: Pick<FiscalDocuments, 'get' | 'readSnapshot' | 'reserveNumber'>,
    private readonly projections: Pick<FiscalProjections, 'readIssuer' | 'readParty'>,
    private readonly calculations: Pick<FiscalCalculations, 'readFrozen'>,
    private readonly artifacts: Pick<FiscalArtifacts, 'put'>,
    private readonly dispatch: Pick<FiscalDispatch, 'queueIssuance' | 'findIssuance'>,
    profile: Nfe55SimulationProfile,
    private readonly credential: SimulationCredential,
    private readonly schemaZip: Buffer,
    private readonly schemaDigest: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 10_000 } })
    this.#profile = nfe55IssuanceProfileSchema.parse(profile)
    digest.parse(schemaDigest)
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async issue(input: z.input<typeof commandSchema>) {
    const command = commandSchema.parse(input)
    const prior = await this.dispatch.findIssuance(
      command.tenantId,
      command.documentId,
      command.idempotencyKey,
    )
    if (prior) {
      const expectedDigest = canonicalDigest({
        documentId: command.documentId,
        accessKey: prior.accessKey,
        signedXmlDigest: prior.signedXmlDigest,
      })
      if (prior.requestDigest !== expectedDigest)
        throw new Error('Conflicting Fiscal dispatch idempotency key')
      return {
        commandId: prior.commandId,
        documentId: prior.documentId,
        kind: 'issuance' as const,
        status: prior.status,
        existing: true,
        accessKey: prior.accessKey,
        unsignedXmlDigest: prior.unsignedXmlDigest,
        signedXmlDigest: prior.signedXmlDigest,
        simulated: true as const,
      }
    }
    const document = await this.documents.get(command.tenantId, command.documentId)
    if (!document) throw new Error('Fiscal document not found')
    if (document.status !== 'ready') throw new Error('Fiscal document is not ready')
    if (
      (document.model !== '55' && document.model !== '65') ||
      document.environment !== 'simulation'
    )
      throw new Error('Fiscal capability is unsupported')
    const evidence = await this.readReadiness(command.tenantId, command.documentId)
    const profileCapabilities =
      document.model === '65'
        ? [this.#profile.consumer?.capabilityId]
        : [
            this.#profile.capabilityId,
            ...Object.values(this.#profile.linked ?? {}).map((entry) => entry.capabilityId),
          ]
    if (!profileCapabilities.includes(evidence.capabilityId))
      throw new Error('Fiscal simulation profile does not match readiness capability')
    // A retry after a crash reuses the bytes already bound: an NFC-e is dated when signed.
    const bound = await this.readBoundArtifacts(command.tenantId, command.documentId)
    if (bound) return this.queue(command, bound)
    const [issuer, recipient, calculation, snapshot, number] = await Promise.all([
      this.projections.readIssuer(command.tenantId, evidence.issuerProfileRevision),
      this.projections.readParty(
        command.tenantId,
        evidence.recipientPartyId,
        evidence.recipientProfileRevision,
      ),
      this.calculations.readFrozen(command.tenantId, command.documentId),
      this.documents.readSnapshot(command.tenantId, command.documentId),
      this.documents.reserveNumber(command.tenantId, command.documentId),
    ])
    if (!issuer || !recipient || !calculation)
      throw new Error('Frozen Fiscal issuance evidence is unavailable')
    const origin = parseFiscalOriginSnapshot(snapshot)
    const facts = { document, number, issuer, recipient, calculation, origin }
    const prepared =
      document.model === '65'
        ? await this.prepareConsumerSale(facts, evidence.capabilityId)
        : await this.prepareNfe(facts, evidence.capabilityId)
    await validateNfe55Schema({
      xml: prepared.signed,
      schemaZip: this.schemaZip,
      expectedZipDigest: this.schemaDigest,
    })
    const unsignedArtifact = await this.artifacts.put(
      {
        tenantId: command.tenantId,
        documentId: command.documentId,
        kind: 'unsigned_xml',
        mediaType: 'application/xml',
        sourceSchema: `PL_010f:${this.schemaDigest}`,
      },
      prepared.unsigned,
    )
    const signedArtifact = await this.artifacts.put(
      {
        tenantId: command.tenantId,
        documentId: command.documentId,
        kind: 'signed_xml',
        mediaType: 'application/xml',
        sourceSchema: `PL_010f:${this.schemaDigest}`,
      },
      prepared.signed,
    )
    await this.artifacts.put(
      {
        tenantId: command.tenantId,
        documentId: command.documentId,
        kind: 'danfe',
        mediaType: 'application/pdf',
        sourceSchema: prepared.danfeSchema,
      },
      prepared.danfe,
    )
    await this.bindIssuance({
      ...command,
      capabilityId: evidence.capabilityId,
      accessKey: prepared.accessKey,
      reconciliationDigest: evidence.reconciliationDigest,
      signedXmlDigest: signedArtifact.digest,
    })
    return this.queue(command, {
      accessKey: prepared.accessKey,
      unsignedXmlDigest: unsignedArtifact.digest,
      signedXmlDigest: signedArtifact.digest,
    })
  }

  private async prepareNfe(facts: IssuanceFacts, capabilityId: string): Promise<Prepared> {
    const xmlData = buildNfe55Data({ ...facts, profile: this.#profile, capabilityId })
    const unsigned = serializeNfe55(xmlData)
    const signed = signNfe55(unsigned, this.credential)
    verifyNfe55Signature(signed, this.credential.certificate)
    return {
      accessKey: xmlData.accessKey,
      unsigned,
      signed,
      danfe: await renderSimulatedDanfe({ signedXml: signed, state: 'preview' }),
      danfeSchema: 'horizon-danfe-preview-v1',
    }
  }

  /** NFC-e model 65: its own builder, QR code, signature placement and DANFE NFC-e. */
  private async prepareConsumerSale(facts: IssuanceFacts, capabilityId: string): Promise<Prepared> {
    const xmlData = buildNfce65Data({
      ...facts,
      profile: this.#profile,
      capabilityId,
      issuedAt: zonedInstant(this.now().toISOString(), facts.issuer.timezone),
    })
    const unsigned = serializeNfce65(xmlData)
    const signed = signNfce65(unsigned, this.credential)
    verifyNfe55Signature(signed, this.credential.certificate)
    return {
      accessKey: xmlData.accessKey,
      unsigned,
      signed,
      danfe: await renderSimulatedDanfeNfce({ signedXml: signed, state: 'preview' }),
      danfeSchema: 'horizon-danfe-nfce-preview-v1',
    }
  }

  private async queue(
    command: z.infer<typeof commandSchema>,
    bound: { accessKey: string; unsignedXmlDigest: string; signedXmlDigest: string },
  ) {
    const requestDigest = canonicalDigest({
      documentId: command.documentId,
      accessKey: bound.accessKey,
      signedXmlDigest: bound.signedXmlDigest,
    })
    const queued = await this.dispatch.queueIssuance({
      ...command,
      requestDigest,
      artifactDigest: bound.signedXmlDigest,
    })
    return { ...queued, ...bound, simulated: true as const }
  }

  private async readBoundArtifacts(tenantId: string, documentId: string) {
    const rows = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select binding.access_key, binding.signed_xml_digest, unsigned.digest as unsigned_digest
        from fiscal_document_issuance_bindings binding
        join lateral (
          select artifact.digest from fiscal_artifacts artifact
          where artifact.tenant_id = binding.tenant_id and artifact.document_id = binding.document_id
            and artifact.kind = 'unsigned_xml'
          order by artifact.created_at desc, artifact.id desc limit 1
        ) unsigned on true
        where binding.tenant_id = ${tenantId} and binding.document_id = ${documentId}`
    })
    const [row] = rows
    if (!row) return null
    return {
      accessKey: String(row.access_key),
      unsignedXmlDigest: String(row.unsigned_digest),
      signedXmlDigest: String(row.signed_xml_digest),
    }
  }

  private async readReadiness(tenantId: string, documentId: string) {
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select binding.capability_id, binding.issuer_profile_revision, binding.recipient_party_id,
          recipient_profile_revision, reconciliation_digest
        from fiscal_document_readiness_bindings binding
        join lateral (
          select event.action from fiscal_capability_activation_events event
          where event.tenant_id = binding.tenant_id
            and event.capability_id = binding.capability_id
          order by event.created_at desc, event.id desc limit 1
        ) latest on latest.action = 'activate_simulated'
        where binding.tenant_id = ${tenantId} and binding.document_id = ${documentId}`
    })
    if (!row) throw new Error('Fiscal readiness capability is inactive or unavailable')
    return {
      capabilityId: String(row.capability_id),
      issuerProfileRevision: Number(row.issuer_profile_revision),
      recipientPartyId: String(row.recipient_party_id),
      recipientProfileRevision: Number(row.recipient_profile_revision),
      reconciliationDigest: String(row.reconciliation_digest),
    }
  }

  private async bindIssuance(input: {
    tenantId: string
    documentId: string
    capabilityId: string
    accessKey: string
    reconciliationDigest: string
    signedXmlDigest: string
  }): Promise<void> {
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${input.tenantId}, true)`
      const inserted = await tx`insert into fiscal_document_issuance_bindings (
          tenant_id, document_id, capability_id, environment, access_key,
          reconciliation_digest, signed_xml_digest
        ) values (
          ${input.tenantId}, ${input.documentId}, ${input.capabilityId}, 'simulation',
          ${input.accessKey}, ${input.reconciliationDigest}, ${input.signedXmlDigest}
        ) on conflict do nothing returning document_id`
      if (inserted.length > 0) return
      const [existing] = await tx`select capability_id, access_key, reconciliation_digest,
          signed_xml_digest from fiscal_document_issuance_bindings
        where tenant_id = ${input.tenantId} and document_id = ${input.documentId}`
      if (
        !existing ||
        String(existing.capability_id) !== input.capabilityId ||
        existing.access_key !== input.accessKey ||
        existing.reconciliation_digest !== input.reconciliationDigest ||
        existing.signed_xml_digest !== input.signedXmlDigest
      )
        throw new Error('Conflicting Fiscal issuance binding')
    })
  }
}

export function buildNfe55Data(input: {
  document: NonNullable<Awaited<ReturnType<FiscalDocuments['get']>>>
  number: number
  issuer: NonNullable<Awaited<ReturnType<FiscalProjections['readIssuer']>>>
  recipient: NonNullable<Awaited<ReturnType<FiscalProjections['readParty']>>>
  calculation: NonNullable<Awaited<ReturnType<FiscalCalculations['readFrozen']>>>
  origin: FiscalOriginSnapshot
  profile: Nfe55SimulationProfile
  capabilityId?: string
}): Nfe55Data {
  const manual =
    input.origin.originModule === 'fiscal' && input.origin.purpose === 'manual'
      ? input.origin
      : null
  const linked =
    input.origin.originModule === 'fiscal' && input.origin.purpose === 'linked'
      ? input.origin
      : null
  const linkedProfile = linked ? input.profile.linked?.[linked.kind] : undefined
  if (linked && (!linkedProfile || linkedProfile.capabilityId !== input.capabilityId))
    throw new Error('NF-e linked issuance profile is incomplete for this capability')
  if (!linked && input.capabilityId && input.capabilityId !== input.profile.capabilityId)
    throw new Error('NF-e sale issued under a linked capability')
  const issuerAddress = input.issuer.company.address
  const recipientAddress = input.recipient.profile.address
  if (
    !input.issuer.company.taxId ||
    !input.issuer.company.stateRegistration ||
    !issuerAddress.city ||
    !issuerAddress.municipalityCode ||
    !issuerAddress.state ||
    !issuerAddress.postalCode ||
    !input.recipient.profile.stateRegistration ||
    !recipientAddress.municipalityCode ||
    !recipientAddress.state
  )
    throw new Error('NF-e party facts are incomplete')
  const numericCode = deterministicNumericCode(input.document.id)
  const issueDate = input.calculation.input.issueDate
  const accessKey = buildNfe55AccessKey({
    issuerUfCode: input.calculation.input.issuer.stateCode,
    issuedOn: issueDate,
    issuerTaxId: input.issuer.company.taxId,
    model: '55',
    series: input.document.series,
    number: input.number,
    numericCode,
  })
  const lines = nfeLines({
    origin: input.origin,
    calculation: input.calculation,
    lineFacts: input.profile.lineFacts,
    cfop: linkedProfile?.cfop,
  })
  return {
    accessKey,
    processVersion:
      input.document.environment === 'homologation' ? 'horizon-phase43' : 'horizon-phase42',
    issuedAt: manual
      ? `${manual.issueDate}T12:00:00-03:00`
      : zonedInstant(input.document.createdAt, input.issuer.timezone),
    natureOperation: linkedProfile?.natureOperation ?? 'Venda de mercadoria',
    operationType: linked?.kind === 'sale-return' ? '0' : '1',
    purpose: !linked ? '1' : linked.kind === 'value-complement' ? '2' : '4',
    references: linked ? linked.references.map((reference) => reference.accessKey) : [],
    numericCode,
    series: input.document.series,
    number: input.number,
    issuer: {
      taxId: input.issuer.company.taxId,
      legalName: input.issuer.company.legalName,
      stateRegistration: input.issuer.company.stateRegistration,
      address: {
        ...input.profile.issuerAddress,
        municipalityCode: issuerAddress.municipalityCode,
        city: issuerAddress.city,
        state: issuerAddress.state,
        postalCode: digits(issuerAddress.postalCode, 8),
      },
    },
    recipient: {
      taxId: input.recipient.taxId,
      legalName: input.recipient.legalName,
      stateRegistration: input.recipient.profile.stateRegistration,
      address: {
        street: recipientAddress.street,
        number: recipientAddress.number,
        complement: recipientAddress.complement,
        district: recipientAddress.district,
        municipalityCode: recipientAddress.municipalityCode,
        city: recipientAddress.city,
        state: recipientAddress.state,
        postalCode: digits(recipientAddress.postalCode, 8),
      },
    },
    lines,
    totals: nfeTotals(lines, input.calculation),
  }
}
