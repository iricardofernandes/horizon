import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalCalculations } from './calculations'
import type { FiscalCapabilities } from './capabilities'
import type { FiscalDocuments } from './documents'
import type { HomologationExchangeLedger } from './homologation-exchange-ledger'
import { buildNfe55Data } from './issuance'
import type { HomologationCredential } from './nfe55/homologation-credential'
import type { SefazNfe55HomologationAdapter } from './nfe55/sefaz-adapter'
import { signNfe55 } from './nfe55/signature'
import { serializeNfe55 } from './nfe55/xml'
import { parseFiscalOriginSnapshot } from './origin-snapshot'
import type { FiscalProjections } from './projections'

const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  drillGrantId: z.uuid(),
  exchangeId: z.uuid(),
  actorId: z.string().min(1).max(200),
})

/** Builds and binds one exact NF-e authorization for a reviewed homologation drill. */
export class HomologationIssuance {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly documents: Pick<
      FiscalDocuments,
      'get' | 'readSnapshot' | 'reserveHomologationNumber'
    >,
    private readonly projections: Pick<FiscalProjections, 'readIssuer' | 'readParty'>,
    private readonly calculations: Pick<FiscalCalculations, 'readFrozen'>,
    private readonly capabilities: Pick<
      FiscalCapabilities,
      'getHomologationDrill' | 'getHomologationIssuanceProfile'
    >,
    private readonly ledger: Pick<HomologationExchangeLedger, 'bindAuthorization' | 'prepare'>,
    private readonly adapter: Pick<
      SefazNfe55HomologationAdapter,
      'prepare' | 'wsdlDigest' | 'certificateFingerprint'
    >,
    private readonly credential: HomologationCredential,
    private readonly schemaZip: Buffer,
    private readonly schemaDigest: string,
  ) {
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async prepare(input: z.input<typeof commandSchema>) {
    const command = commandSchema.parse(input)
    const document = await this.documents.get(command.tenantId, command.documentId)
    if (
      document?.status !== 'ready' ||
      document.model !== '55' ||
      document.environment !== 'homologation'
    )
      throw new Error('Ready NF-e homologation document is unavailable')

    const [evidence] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${command.tenantId}, true)`
      return tx`select readiness.capability_id, readiness.issuer_profile_revision,
          readiness.recipient_party_id, readiness.recipient_profile_revision,
          grant_row.endpoint_digest, grant_row.wsdl_digest,
          grant_row.certificate_fingerprint, definition.schema_package_digest,
          definition.adapter_version
        from fiscal_document_readiness_bindings readiness
        join fiscal_homologation_drill_grants grant_row
          on grant_row.tenant_id = readiness.tenant_id
          and grant_row.capability_id = readiness.capability_id
          and grant_row.document_id = readiness.document_id
        join fiscal_capability_definitions definition
          on definition.tenant_id = readiness.tenant_id
          and definition.id = readiness.capability_id
        where readiness.tenant_id = ${command.tenantId}
          and readiness.document_id = ${command.documentId}
          and grant_row.id = ${command.drillGrantId}
          and grant_row.expires_at > now()`
    })
    if (!evidence) throw new Error('Homologation readiness or drill is unavailable')
    const capability = await this.capabilities.getHomologationDrill(
      command.tenantId,
      command.documentId,
      command.drillGrantId,
    )
    if (
      !capability ||
      capability.id !== evidence.capability_id ||
      capability.establishmentId !== document.establishmentId
    )
      throw new Error('Homologation drill differs from ready document')
    if (
      evidence.schema_package_digest !== this.schemaDigest ||
      evidence.wsdl_digest !== this.adapter.wsdlDigest ||
      evidence.certificate_fingerprint !== this.adapter.certificateFingerprint ||
      evidence.certificate_fingerprint !== this.credential.fingerprint
    )
      throw new Error('Homologation schema, WSDL or certificate differs from drill')
    if (this.credential.validUntil <= Date.now() + this.credential.minimumRemainingMilliseconds)
      throw new Error('Homologation certificate is expiring')

    const [profile, issuer, recipient, calculation, snapshot] = await Promise.all([
      this.capabilities.getHomologationIssuanceProfile(command.tenantId, capability.id),
      this.projections.readIssuer(command.tenantId, Number(evidence.issuer_profile_revision)),
      this.projections.readParty(
        command.tenantId,
        String(evidence.recipient_party_id),
        Number(evidence.recipient_profile_revision),
      ),
      this.calculations.readFrozen(command.tenantId, command.documentId),
      this.documents.readSnapshot(command.tenantId, command.documentId),
    ])
    if (!profile || !issuer || !recipient || !calculation)
      throw new Error('Reviewed homologation issuance facts are unavailable')
    if (issuer.company.taxId !== this.credential.issuerTaxId)
      throw new Error('Homologation issuer differs from certificate')
    const origin = parseFiscalOriginSnapshot(snapshot)
    for (const line of origin.lines) {
      if (!profile.lineFacts[line.itemId])
        throw new Error('Reviewed homologation product mapping is incomplete')
    }
    const number = await this.documents.reserveHomologationNumber(
      command.tenantId,
      command.documentId,
      command.drillGrantId,
    )
    const data = buildNfe55Data({
      document,
      number,
      issuer,
      recipient,
      calculation,
      origin,
      profile,
    })
    const signedXml = signNfe55(serializeNfe55(data), this.credential)
    const exchangeInput = {
      ...command,
      parentExchangeId: null,
      endpointDigest: String(evidence.endpoint_digest),
      wsdlDigest: String(evidence.wsdl_digest),
      certificateFingerprint: String(evidence.certificate_fingerprint),
      adapterVersion: String(evidence.adapter_version),
    }
    const bound = await this.ledger.bindAuthorization(
      exchangeInput,
      {
        service: 'authorization',
        lotId: String(number),
        accessKey: data.accessKey,
        signedXml,
        schemaZip: this.schemaZip,
        schemaDigest: this.schemaDigest,
      },
      this.adapter,
    )
    const recorded = await this.ledger.prepare(exchangeInput, bound.prepared)
    if (recorded.requestDigest !== bound.requestDigest)
      throw new Error('Prepared SEFAZ request differs from signed authorization binding')
    return { accessKey: data.accessKey, number, ...bound, exchangeId: recorded.exchangeId }
  }
}
