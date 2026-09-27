import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalArtifacts } from '../artifacts'
import type { FiscalCalculations } from '../calculations'
import { canonicalDigest } from '../canonical-json'
import type { FiscalDispatch } from '../dispatch'
import type { FiscalDocuments } from '../documents'
import { minorToFixed, zonedInstant } from '../nfe-values'
import type { Nfe55IssuanceProfile } from '../nfe55/issuance-profile'
import type { SimulationCredential } from '../nfe55/signature'
import type { FiscalProjections } from '../projections'
import { MunicipalityUnsupported } from './errors'
import { buildDpsId } from './identifiers'
import { type NfseDpsData, nfseDpsDataSchema } from './model'
import type { FiscalNfseRegistry } from './registry'
import { NFSE_SCHEMA_DIGEST, validateNfseSchema } from './schema'
import { assertIssuer, serviceOriginPayloadSchema } from './service-origins'
import { signNfseElement, verifyNfseElement } from './signature'
import { serializeDps } from './xml'

const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  idempotencyKey: z.string().min(16).max(128),
  actorId: z.string().min(1).max(200),
})
export const NFSE_SOURCE_SCHEMA = `nfse-xsd-v1.01:${NFSE_SCHEMA_DIGEST}`

export type ServiceProfile = NonNullable<Nfe55IssuanceProfile['service']>

/** Prepares the signed DPS and only then crosses the durable dispatch boundary. */
export class FiscalServiceIssuance {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly documents: Pick<FiscalDocuments, 'get' | 'readSnapshot' | 'reserveNumber'>,
    private readonly projections: Pick<FiscalProjections, 'readIssuer' | 'readParty'>,
    private readonly calculations: Pick<FiscalCalculations, 'readFrozen'>,
    private readonly artifacts: Pick<FiscalArtifacts, 'put'>,
    private readonly dispatch: Pick<FiscalDispatch, 'queueIssuance' | 'findIssuance'>,
    private readonly registry: Pick<FiscalNfseRegistry, 'resolve'>,
    private readonly profile: ServiceProfile,
    private readonly credential: SimulationCredential,
    private readonly schemaZip: Buffer,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  private async withdrawnInSales(tenantId: string, documentId: string): Promise<boolean> {
    const rows = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select 1 from fiscal_service_intakes where tenant_id = ${tenantId}
        and document_id = ${documentId} and withdrawal_requested`
    })
    return rows.length > 0
  }

  async issue(input: z.input<typeof commandSchema>) {
    const command = commandSchema.parse(input)
    const prior = await this.dispatch.findIssuance(
      command.tenantId,
      command.documentId,
      command.idempotencyKey,
    )
    if (prior) {
      if (
        prior.requestDigest !==
        requestDigestOf(command.documentId, prior.accessKey, prior.signedXmlDigest)
      )
        throw new Error('Conflicting Fiscal dispatch idempotency key')
      return {
        commandId: prior.commandId,
        documentId: prior.documentId,
        kind: 'issuance' as const,
        status: prior.status,
        existing: true,
        dpsId: prior.accessKey,
        signedXmlDigest: prior.signedXmlDigest,
        simulated: true as const,
      }
    }
    const document = await this.documents.get(command.tenantId, command.documentId)
    if (!document) throw new Error('Fiscal document not found')
    if (document.status !== 'ready') throw new Error('Fiscal document is not ready')
    // A delivery cancelled in Sales withdrew this draft (Phase 50): it is never issued.
    if (await this.withdrawnInSales(command.tenantId, command.documentId))
      throw new Error('Fiscal document is blocked: its service delivery was cancelled in Sales')
    if (document.model !== 'nfse' || document.environment !== 'simulation')
      throw new Error('Fiscal capability is unsupported')
    const evidence = await this.readReadiness(command.tenantId, command.documentId)
    if (evidence.capabilityId !== this.profile.capabilityId)
      throw new Error('Fiscal service profile does not match readiness capability')
    const origin = serviceOriginPayloadSchema.parse(
      await this.documents.readSnapshot(command.tenantId, command.documentId),
    )
    // The registry is read again: an unsupported municipality never reaches the queue.
    const resolution = await this.registry.resolve(
      command.tenantId,
      origin.municipalityCode,
      origin.competenceDate,
    )
    if (
      resolution.route !== 'national' ||
      origin.municipalityCode !== this.profile.municipalityCode
    )
      throw new MunicipalityUnsupported(resolution.reason ?? 'Municipality is unsupported')
    // A retry after a crash reuses the bytes already bound.
    const bound = await this.readBound(command.tenantId, command.documentId)
    if (bound) return this.queue(command, bound)
    const [issuer, recipient, calculation, number, substitution] = await Promise.all([
      this.projections.readIssuer(command.tenantId, evidence.issuerProfileRevision),
      this.projections.readParty(
        command.tenantId,
        evidence.recipientPartyId,
        evidence.recipientProfileRevision,
      ),
      this.calculations.readFrozen(command.tenantId, command.documentId),
      this.documents.reserveNumber(command.tenantId, command.documentId),
      this.readSubstitution(command.tenantId, command.documentId),
    ])
    if (!issuer || !recipient || !calculation)
      throw new Error('Frozen Fiscal issuance evidence is unavailable')
    assertIssuer(issuer)
    const cnpj = String(issuer.company.taxId)
    const recipientAddress = recipient.profile.address
    const data: NfseDpsData = nfseDpsDataSchema.parse({
      dpsId: buildDpsId({
        municipalityCode: origin.municipalityCode,
        cnpj,
        series: document.series,
        number,
      }),
      environment: '2',
      issuedAt: zonedInstant(this.now().toISOString(), issuer.timezone),
      applicationVersion: 'horizon-phase47',
      series: document.series,
      number,
      competenceDate: origin.competenceDate,
      issuingMunicipality: origin.municipalityCode,
      provider: {
        cnpj,
        municipalRegistration: issuer.company.municipalRegistration,
        simplesOption: '1',
        specialRegime: '0',
      },
      recipient: {
        kind: recipient.taxId.length === 11 ? 'cpf' : 'cnpj',
        taxId: recipient.taxId,
        name: recipient.legalName,
        address: {
          municipalityCode: recipientAddress.municipalityCode,
          postalCode: recipientAddress.postalCode.replace(/\D/g, ''),
          street: recipientAddress.street,
          number: recipientAddress.number,
          complement: recipientAddress.complement,
          district: recipientAddress.district,
        },
      },
      service: {
        placeMunicipality: origin.municipalityCode,
        nationalTaxCode: origin.nationalTaxCode,
        municipalTaxCode: origin.municipalTaxCode,
        description: origin.description,
        nbsCode: origin.nbsCode,
      },
      values: {
        serviceAmount: minorToFixed(calculation.result.totals.gross.amount),
        issTaxation: '1',
        withholding: '1',
      },
      substitution,
      ibsCbs: {
        purpose: '0',
        operationIndicator: this.profile.operationIndicator,
        destination: '0',
        cst: this.profile.ibsCbs.cst,
        classification: this.profile.ibsCbs.classification,
      },
    })
    const unsigned = serializeDps(data)
    const signed = signNfseElement(unsigned, 'infDPS', this.credential)
    verifyNfseElement(signed, 'infDPS', this.credential.certificate)
    await validateNfseSchema({ xml: signed, root: 'DPS', schemaZip: this.schemaZip })
    const put = (kind: 'unsigned_xml' | 'signed_xml', bytes: Buffer) =>
      this.artifacts.put(
        {
          tenantId: command.tenantId,
          documentId: command.documentId,
          kind,
          mediaType: 'application/xml',
          sourceSchema: NFSE_SOURCE_SCHEMA,
        },
        bytes,
      )
    const unsignedArtifact = await put('unsigned_xml', unsigned)
    const signedArtifact = await put('signed_xml', signed)
    await this.bind({
      tenantId: command.tenantId,
      documentId: command.documentId,
      capabilityId: evidence.capabilityId,
      dpsId: data.dpsId,
      reconciliationDigest: evidence.reconciliationDigest,
      signedXmlDigest: signedArtifact.digest,
    })
    return this.queue(command, {
      dpsId: data.dpsId,
      unsignedXmlDigest: unsignedArtifact.digest,
      signedXmlDigest: signedArtifact.digest,
    })
  }

  private async queue(
    command: z.infer<typeof commandSchema>,
    bound: { dpsId: string; unsignedXmlDigest: string; signedXmlDigest: string },
  ) {
    const queued = await this.dispatch.queueIssuance({
      ...command,
      requestDigest: requestDigestOf(command.documentId, bound.dpsId, bound.signedXmlDigest),
      artifactDigest: bound.signedXmlDigest,
    })
    return { ...queued, ...bound, simulated: true as const }
  }

  /** The `subst` group of a substitute: the original's key and the reviewed reason. */
  private async readSubstitution(tenantId: string, documentId: string) {
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select request.reason_code, request.reason, generation.nfse_key
        from fiscal_nfse_substitution_requests request
        join fiscal_nfse_generations generation on generation.tenant_id = request.tenant_id
          and generation.document_id = request.original_document_id
        where request.tenant_id = ${tenantId} and request.substitute_document_id = ${documentId}`
    })
    if (!row) return null
    return {
      replacedKey: String(row.nfse_key),
      reasonCode: String(row.reason_code) as '01' | '02' | '03' | '04' | '05' | '99',
      reason: row.reason === null ? null : String(row.reason),
    }
  }

  private async readBound(tenantId: string, documentId: string) {
    const [row] = await this.#db.begin(async (tx) => {
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
    if (!row) return null
    return {
      dpsId: String(row.access_key),
      unsignedXmlDigest: String(row.unsigned_digest),
      signedXmlDigest: String(row.signed_xml_digest),
    }
  }

  private async readReadiness(tenantId: string, documentId: string) {
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select binding.capability_id, binding.issuer_profile_revision,
          binding.recipient_party_id, binding.recipient_profile_revision,
          binding.reconciliation_digest
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

  private async bind(input: {
    tenantId: string
    documentId: string
    capabilityId: string
    dpsId: string
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
          ${input.dpsId}, ${input.reconciliationDigest}, ${input.signedXmlDigest}
        ) on conflict do nothing returning document_id`
      if (inserted.length > 0) return
      const [existing] = await tx`select capability_id, access_key, signed_xml_digest
        from fiscal_document_issuance_bindings
        where tenant_id = ${input.tenantId} and document_id = ${input.documentId}`
      if (
        !existing ||
        String(existing.capability_id) !== input.capabilityId ||
        existing.access_key !== input.dpsId ||
        existing.signed_xml_digest !== input.signedXmlDigest
      )
        throw new Error('Conflicting Fiscal issuance binding')
    })
  }
}

function requestDigestOf(documentId: string, dpsId: string, signedXmlDigest: string): string {
  return canonicalDigest({ documentId, dpsId, signedXmlDigest })
}
