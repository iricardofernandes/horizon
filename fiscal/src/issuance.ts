import { createHash } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalArtifacts } from './artifacts'
import type { FiscalCalculations } from './calculations'
import { canonicalDigest } from './canonical-json'
import type { FiscalDispatch } from './dispatch'
import type { FiscalDocuments } from './documents'
import { buildNfe55AccessKey } from './nfe55/access-key'
import { renderSimulatedDanfe } from './nfe55/danfe'
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
const profileSchema = z.strictObject({
  capabilityId: z.uuid(),
  issuerAddress: z.strictObject({
    street: z.string().min(2).max(60),
    number: z.string().min(1).max(60),
    complement: z.string().min(1).max(60).nullable(),
    district: z.string().min(2).max(60),
  }),
  lineFacts: z.record(
    z.uuid(),
    z.strictObject({
      productCode: z.string().min(1).max(60),
      cfop: z.string().regex(/^5\d{3}$/),
      unit: z.string().min(1).max(6),
      ibsCbsCst: z.string().regex(/^\d{3}$/),
      ibsCbsClassification: z.string().regex(/^\d{6}$/),
    }),
  ),
})

export type Nfe55SimulationProfile = z.infer<typeof profileSchema>

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
  ) {
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 10_000 } })
    this.#profile = profileSchema.parse(profile)
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
    if (document.model !== '55' || document.environment !== 'simulation')
      throw new Error('Fiscal capability is unsupported')
    const evidence = await this.readReadiness(command.tenantId, command.documentId)
    if (evidence.capabilityId !== this.#profile.capabilityId)
      throw new Error('Fiscal simulation profile does not match readiness capability')
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
    const xmlData = buildNfe55Data({
      document,
      number,
      issuer,
      recipient,
      calculation,
      origin,
      profile: this.#profile,
    })
    const unsigned = serializeNfe55(xmlData)
    const signed = signNfe55(unsigned, this.credential)
    verifyNfe55Signature(signed, this.credential.certificate)
    await validateNfe55Schema({
      xml: signed,
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
      unsigned,
    )
    const signedArtifact = await this.artifacts.put(
      {
        tenantId: command.tenantId,
        documentId: command.documentId,
        kind: 'signed_xml',
        mediaType: 'application/xml',
        sourceSchema: `PL_010f:${this.schemaDigest}`,
      },
      signed,
    )
    await this.artifacts.put(
      {
        tenantId: command.tenantId,
        documentId: command.documentId,
        kind: 'danfe',
        mediaType: 'application/pdf',
        sourceSchema: 'horizon-danfe-preview-v1',
      },
      await renderSimulatedDanfe({ signedXml: signed, state: 'preview' }),
    )
    await this.bindIssuance({
      ...command,
      capabilityId: evidence.capabilityId,
      accessKey: xmlData.accessKey,
      reconciliationDigest: evidence.reconciliationDigest,
      signedXmlDigest: signedArtifact.digest,
    })
    const requestDigest = canonicalDigest({
      documentId: command.documentId,
      accessKey: xmlData.accessKey,
      signedXmlDigest: signedArtifact.digest,
    })
    const queued = await this.dispatch.queueIssuance({
      ...command,
      requestDigest,
      artifactDigest: signedArtifact.digest,
    })
    return {
      ...queued,
      accessKey: xmlData.accessKey,
      unsignedXmlDigest: unsignedArtifact.digest,
      signedXmlDigest: signedArtifact.digest,
      simulated: true as const,
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
}): Nfe55Data {
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
  const calculated = new Map(input.calculation.result.lines.map((line) => [line.lineId, line]))
  const lines = input.origin.lines.map((originLine, index) => {
    const facts = input.profile.lineFacts[originLine.itemId]
    const line = calculated.get(originLine.lineId)
    if (!facts || !line) throw new Error('NF-e line facts are incomplete')
    const components = new Map(
      line.components.ibsCbs.map((component) => [component.code, component]),
    )
    const cbs = components.get('CBS')
    const ibsUf = components.get('IBS_UF')
    const ibsMunicipal = components.get('IBS_MUN')
    if (!cbs || !ibsUf || !ibsMunicipal)
      throw new Error('NF-e IBS/CBS calculation components are incomplete')
    if (cbs.base.amount !== ibsUf.base.amount || cbs.base.amount !== ibsMunicipal.base.amount)
      throw new Error('NF-e IBS/CBS bases do not reconcile')
    return {
      number: index + 1,
      productCode: facts.productCode,
      description: originLine.description,
      ncm: input.calculation.input.lines.find((candidate) => candidate.id === originLine.lineId)
        ?.classifications.ncm as string,
      cfop: facts.cfop,
      unit: facts.unit,
      quantity: decimal4(originLine.quantity),
      unitPrice: minorToDecimal(originLine.unitPrice.amount),
      gross: minorToFixed(line.gross.amount),
      discount: '0.00',
      other: '0.00',
      ibsCbs: {
        cst: facts.ibsCbsCst,
        classification: facts.ibsCbsClassification,
        base: minorToFixed(cbs.base.amount),
        ibsUfRate: percent(ibsUf.rate),
        ibsUfValue: minorToFixed(ibsUf.amount.amount),
        ibsMunicipalRate: percent(ibsMunicipal.rate),
        ibsMunicipalValue: minorToFixed(ibsMunicipal.amount.amount),
        cbsRate: percent(cbs.rate),
        cbsValue: minorToFixed(cbs.amount.amount),
      },
    }
  })
  const sum = (members: string[]) => members.reduce((total, value) => total + BigInt(value), 0n)
  const ibsUf = sum(lines.map((line) => line.ibsCbs.ibsUfValue.replace('.', '')))
  const ibsMunicipal = sum(lines.map((line) => line.ibsCbs.ibsMunicipalValue.replace('.', '')))
  const cbs = sum(lines.map((line) => line.ibsCbs.cbsValue.replace('.', '')))
  const invoice = BigInt(input.calculation.result.totals.net.amount)
  return {
    accessKey,
    issuedAt:
      input.origin.originModule === 'fiscal'
        ? `${input.origin.issueDate}T12:00:00-03:00`
        : zonedInstant(input.document.createdAt, input.issuer.timezone),
    natureOperation: 'Venda de mercadoria',
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
    totals: {
      products: minorToFixed(input.calculation.result.totals.gross.amount),
      discounts: minorToFixed(input.calculation.result.totals.discounts.amount),
      other: minorToFixed(input.calculation.result.totals.charges.amount),
      invoice: minorToFixed(invoice.toString()),
      ibsUf: minorToFixed(ibsUf.toString()),
      ibsMunicipal: minorToFixed(ibsMunicipal.toString()),
      ibs: minorToFixed((ibsUf + ibsMunicipal).toString()),
      cbs: minorToFixed(cbs.toString()),
      ibsCbsBase: minorToFixed(
        sum(lines.map((line) => line.ibsCbs.base.replace('.', ''))).toString(),
      ),
      invoiceWithIbsCbs: minorToFixed((invoice + ibsUf + ibsMunicipal + cbs).toString()),
    },
  }
}

function deterministicNumericCode(documentId: string): string {
  const value = createHash('sha256').update(documentId).digest().readUInt32BE(0) % 100_000_000
  return String(value).padStart(8, '0')
}

function minorToDecimal(value: string): string {
  const fixed = minorToFixed(value)
  return fixed.replace(/\.00$/, '')
}

function minorToFixed(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error('NF-e supports non-negative BRL amounts only')
  const padded = value.padStart(3, '0')
  return `${padded.slice(0, -2).replace(/^0+(?=\d)/, '')}.${padded.slice(-2)}`
}

function decimal4(value: string): string {
  if (!/^\d+(?:\.\d{1,4})?$/.test(value)) throw new Error('NF-e quantity exceeds four decimals')
  const [integer, fraction = ''] = value.split('.')
  return `${integer}.${fraction.padEnd(4, '0')}`
}

function percent(rate: { numerator: string; denominator: string }): string {
  const scaled = (BigInt(rate.numerator) * 1_000_000n) / BigInt(rate.denominator)
  return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, '0')}`
}

function digits(value: string, length: number): string {
  const normalized = value.replace(/\D/g, '')
  if (normalized.length !== length) throw new Error('NF-e address code is invalid')
  return normalized
}

function zonedInstant(instant: string, timezone: string): string {
  const date = new Date(instant)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
  const parts = formatter.formatToParts(date)
  const member = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value
  const offset = member('timeZoneName')?.replace('GMT', '')
  if (!offset || !/^[+-]\d{2}:\d{2}$/.test(offset)) throw new Error('NF-e timezone is invalid')
  return `${member('year')}-${member('month')}-${member('day')}T${member('hour')}:${member('minute')}:${member('second')}${offset}`
}
