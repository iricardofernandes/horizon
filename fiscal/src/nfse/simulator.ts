import { createHash } from 'node:crypto'
import { DOMParser } from '@xmldom/xmldom'
import { SignedXml } from 'xml-crypto'
import { z } from 'zod'
import type { SimulationCredential } from '../nfe55/signature'
import type { SimulatorScenario } from '../nfe55/simulator'
import { tag } from '../nfe55/xml'
import { NFSE_CANCELLATION_EVENT } from './event'
import { buildDpsId, buildNfseKey, isNfseKey, parseDpsId } from './identifiers'
import { ibgeMunicipality, nationalServiceDescription, nbsDescription } from './reference'
import { signNfseElement } from './signature'
import { NFSE_LAYOUT_VERSION, NFSE_NAMESPACE } from './xml'

export const NFSE_SUBSTITUTION_EVENT = '105102'
const APPLICATION = 'horizon-sefin-sim'

/** What the simulated national system knows about one municipality (its parameters). */
export type NfseMunicipalParameters = {
  municipalityCode: string
  agreement: 'active' | 'inactive'
  nationalIssuer: boolean
  startsOn: string
  /** ISS rate per national tax code, as `/parametros_municipais/{mun}/{service}` answers. */
  issRates: Record<string, { numerator: string; denominator: string }>
  cancellationWindowDays: number
}

/** IBS/CBS reference rates the simulated system applies (RTC 2026 test rates). */
export type NfseIbsCbsRates = {
  cbs: { numerator: string; denominator: string }
  ibsUf: { numerator: string; denominator: string }
  ibsMun: { numerator: string; denominator: string }
}

/** The simulated CNPJ cadastre answer for the provider, which the DPS may not carry. */
export type NfseSimulatedProvider = {
  legalName: string
  address: {
    street: string
    number: string
    district: string
    municipalityCode: string
    uf: string
    postalCode: string
  }
}

export type NfseGeneration = {
  nfseKey: string
  nfseNumber: string
  dpsId: string
  processedAt: string
  serviceAmount: string
  issRate: string
  issAmount: string
  cbsAmount: string
  ibsUfAmount: string
  ibsMunAmount: string
  substitutedKey: string | null
}

export type NfseSimulatorResult = {
  outcome: 'authorized' | 'rejected' | 'unknown' | 'not_found'
  providerCorrelation: string | null
  rejectionCode: string | null
  response: Buffer
  /** The generated NFS-e, signed by the simulated system. */
  nfseXml: Buffer | null
  generation: NfseGeneration | null
  /** Event 105102 cancelling the substituted NFS-e, when the DPS substitutes one. */
  substitutionEvent: Buffer | null
}

export type NfseEventSimulatorResult = {
  outcome: 'cancelled' | 'rejected' | 'unknown' | 'not_found'
  providerCorrelation: string | null
  rejectionCode: string | null
  response: Buffer
  /** The registered event (`evento`), signed by the simulated system. */
  protocol: Buffer | null
}

const requestSchema = z.strictObject({
  commandId: z.uuid(),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  dpsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  attemptCount: z.number().int().positive(),
})
const eventRequestSchema = requestSchema.omit({ dpsDigest: true }).extend({
  eventXmlDigest: z.string().regex(/^[0-9a-f]{64}$/),
})

type Request = z.infer<typeof requestSchema>
type Dps = ReturnType<typeof readDps>

/**
 * The Sefin Nacional (national NFS-e issuing system) in simulation. Generation is
 * synchronous. Outcomes depend on the persisted command identity, never on hidden state,
 * so a restart replays the same decision. Consultation takes the DPS it received, which
 * stands for the copy the national system stores (`GET /dps/{id}` then `GET /nfse/{key}`).
 */
export class DeterministicNfseSimulator {
  readonly #municipalities: Map<string, NfseMunicipalParameters>

  constructor(
    municipalities: readonly NfseMunicipalParameters[],
    private readonly ibsCbs: NfseIbsCbsRates,
    private readonly credential: SimulationCredential,
    private readonly chooseScenario: (requestDigest: string) => SimulatorScenario = defaultScenario,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#municipalities = new Map(municipalities.map((entry) => [entry.municipalityCode, entry]))
  }

  /** `POST /nfse`: validates the DPS and generates the NFS-e, or rejects it. */
  async submit(
    input: z.input<typeof requestSchema> & {
      signedDps: Buffer
      provider: NfseSimulatedProvider
    },
  ): Promise<NfseSimulatorResult> {
    const { signedDps, provider, ...candidate } = input
    const request = requestSchema.parse(candidate)
    const dps = this.receive(request, signedDps)
    const scenario = this.chooseScenario(request.requestDigest)
    if (
      request.attemptCount === 1 &&
      (scenario === 'timeout-before-accept' ||
        scenario === 'timeout-after-accept' ||
        scenario === 'delayed-consultation')
    )
      return this.envelope(request, scenario, 'unknown', null, dps, null)
    // The national system generated it on the first send: a resend is a duplicate.
    if (scenario === 'timeout-after-accept' || scenario === 'delayed-consultation')
      return this.envelope(request, scenario, 'rejected', 'E0014', dps, null)
    const processedAt =
      scenario === 'timeout-before-accept' ? this.now() : promptProcessing(dps.issuedAt, request)
    return this.decide(request, scenario, dps, provider, signedDps, processedAt)
  }

  /** `GET /dps/{id}` and, when found, `GET /nfse/{key}`. */
  async consult(
    input: z.input<typeof requestSchema> & {
      signedDps: Buffer
      provider: NfseSimulatedProvider
    },
  ): Promise<NfseSimulatorResult> {
    const { signedDps, provider, ...candidate } = input
    const request = requestSchema.parse(candidate)
    const dps = this.receive(request, signedDps)
    const scenario = this.chooseScenario(request.requestDigest)
    if (scenario === 'timeout-before-accept' && request.attemptCount === 2)
      return this.envelope(request, scenario, 'not_found', null, dps, null)
    if (scenario === 'delayed-consultation' && request.attemptCount < 3)
      return this.envelope(request, scenario, 'unknown', null, dps, null)
    return this.decide(
      request,
      scenario,
      dps,
      provider,
      signedDps,
      promptProcessing(dps.issuedAt, request),
    )
  }

  /** `POST /nfse/{key}/eventos` for event 101101. */
  async submitCancellation(
    input: z.input<typeof eventRequestSchema> & { eventXml: Buffer; nfseXml: Buffer },
  ): Promise<NfseEventSimulatorResult> {
    const { eventXml, nfseXml, ...candidate } = input
    const request = eventRequestSchema.parse(candidate)
    if (sha256(eventXml) !== request.eventXmlDigest)
      throw new Error('Simulator cancellation event digest mismatch')
    const scenario = this.chooseScenario(request.requestDigest)
    if (
      request.attemptCount === 1 &&
      (scenario === 'timeout-before-accept' ||
        scenario === 'timeout-after-accept' ||
        scenario === 'delayed-consultation')
    )
      return this.eventEnvelope(request, scenario, 'unknown', null, null)
    return this.decideCancellation(request, scenario, eventXml, nfseXml)
  }

  /** `GET /nfse/{key}/eventos/101101`. */
  async consultCancellation(
    input: z.input<typeof eventRequestSchema> & { eventXml: Buffer; nfseXml: Buffer },
  ): Promise<NfseEventSimulatorResult> {
    const { eventXml, nfseXml, ...candidate } = input
    const request = eventRequestSchema.parse(candidate)
    const scenario = this.chooseScenario(request.requestDigest)
    if (scenario === 'timeout-before-accept' && request.attemptCount === 2)
      return this.eventEnvelope(request, scenario, 'not_found', null, null)
    if (scenario === 'delayed-consultation' && request.attemptCount < 3)
      return this.eventEnvelope(request, scenario, 'unknown', null, null)
    return this.decideCancellation(request, scenario, eventXml, nfseXml)
  }

  private receive(request: Request, signedDps: Buffer): Dps {
    if (sha256(signedDps) !== request.dpsDigest) throw new Error('Simulator DPS digest mismatch')
    return readDps(signedDps)
  }

  private decide(
    request: Request,
    scenario: SimulatorScenario,
    dps: Dps,
    provider: NfseSimulatedProvider,
    signedDps: Buffer,
    processedAt: Date,
  ): NfseSimulatorResult {
    if (scenario === 'rejected')
      return this.envelope(request, scenario, 'rejected', 'SIMULATED_REJECTION', dps, null)
    const problem = this.check(dps, processedAt)
    if (problem) return this.envelope(request, scenario, 'rejected', problem, dps, null)
    const municipality = this.#municipalities.get(dps.issuingMunicipality)
    const issRate = municipality?.issRates[dps.nationalTaxCode]
    if (!issRate)
      return this.envelope(request, scenario, 'rejected', 'SIMULATED_NO_MUNICIPAL_RATE', dps, null)
    const generation = this.generation(dps, processedAt, issRate, request)
    const nfseXml = signNfseElement(
      this.nfse(dps, generation, provider, signedDps),
      'infNFSe',
      this.credential,
    )
    const substitutionEvent = generation.substitutedKey
      ? this.substitutionEvent(dps, generation)
      : null
    return this.envelope(
      request,
      scenario,
      'authorized',
      null,
      dps,
      generation,
      nfseXml,
      substitutionEvent,
    )
  }

  /** The rules of Anexo I that the simulated system can check with what it knows. */
  private check(dps: Dps, processedAt: Date): string | null {
    const id = parseDpsId(dps.dpsId)
    if (
      dps.dpsId !==
      buildDpsId({
        municipalityCode: dps.issuingMunicipality,
        cnpj: dps.providerCnpj,
        series: dps.series,
        number: dps.number,
      })
    )
      return 'E0004'
    if (dps.environment !== '2') return 'E0006'
    if (Date.parse(dps.issuedAt) > processedAt.getTime()) return 'E0008'
    if (id.series > 49_999) return 'E0010'
    if (dps.competenceDate > dps.issuedAt.slice(0, 10)) return 'E0015'
    const municipality = this.#municipalities.get(dps.issuingMunicipality)
    if (!municipality) return 'E0037'
    if (municipality.agreement !== 'active') return 'E0038'
    if (!municipality.nationalIssuer) return 'E0039'
    if (dps.competenceDate < municipality.startsOn) return 'E0016'
    if (dps.hasRate) return 'E0617'
    if (!nationalServiceDescription(dps.nationalTaxCode)) return 'E0310'
    if (dps.substitutedKey) {
      if (
        !isNfseKey(dps.substitutedKey) ||
        dps.substitutedKey.slice(0, 7) !== dps.issuingMunicipality ||
        dps.substitutedKey.slice(9, 23) !== dps.providerCnpj
      )
        return 'E0042'
    }
    return null
  }

  private generation(
    dps: Dps,
    processedAt: Date,
    issRate: { numerator: string; denominator: string },
    request: Request,
  ): NfseGeneration {
    const processed = localInstant(processedAt)
    const nfseNumber = String(dps.number)
    const base = cents(dps.serviceAmount)
    return {
      nfseKey: buildNfseKey({
        municipalityCode: dps.issuingMunicipality,
        generatingEnvironment: '2',
        cnpj: dps.providerCnpj,
        nfseNumber: dps.number,
        yearMonth: `${processed.slice(2, 4)}${processed.slice(5, 7)}`,
        numericCode: digits(`${dps.dpsId}:${request.requestDigest}`, 9),
      }),
      nfseNumber,
      dpsId: dps.dpsId,
      processedAt: processed,
      serviceAmount: dps.serviceAmount,
      issRate: percent(issRate),
      issAmount: fromCents(apply(base, issRate)),
      cbsAmount: fromCents(apply(base, this.ibsCbs.cbs)),
      ibsUfAmount: fromCents(apply(base, this.ibsCbs.ibsUf)),
      ibsMunAmount: fromCents(apply(base, this.ibsCbs.ibsMun)),
      substitutedKey: dps.substitutedKey,
    }
  }

  /** `NFSe` 1.01 with `infNFSe` and the DPS as received. */
  private nfse(
    dps: Dps,
    generation: NfseGeneration,
    provider: NfseSimulatedProvider,
    signedDps: Buffer,
  ): Buffer {
    const place = ibgeMunicipality(dps.placeMunicipality)
    const issuing = ibgeMunicipality(dps.issuingMunicipality)
    const serviceText = nationalServiceDescription(dps.nationalTaxCode)
    if (!place || !issuing || !serviceText) throw new Error('Simulated NFS-e reference is missing')
    const nbs = dps.nbsCode ? nbsDescription(dps.nbsCode) : null
    const ibsTotal = fromCents(cents(generation.ibsUfAmount) + cents(generation.ibsMunAmount))
    const dpsElement = signedDps
      .toString('utf8')
      .replace(/^<\?xml[^>]*\?>/, '')
      .trim()
    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<NFSe xmlns="${NFSE_NAMESPACE}" versao="${NFSE_LAYOUT_VERSION}">`,
      `<infNFSe Id="NFS${generation.nfseKey}">`,
      tag('xLocEmi', issuing.name),
      tag('xLocPrestacao', place.name),
      tag('nNFSe', generation.nfseNumber),
      tag('cLocIncid', dps.placeMunicipality),
      tag('xLocIncid', place.name),
      tag('xTribNac', serviceText.slice(0, 600)),
      nbs ? tag('xNBS', nbs.slice(0, 600)) : '',
      tag('verAplic', APPLICATION),
      tag('ambGer', '2'),
      tag('tpEmis', '1'),
      tag('procEmi', '1'),
      tag('cStat', '100'),
      tag('dhProc', generation.processedAt),
      tag('nDFSe', generation.nfseNumber),
      '<emit>',
      tag('CNPJ', dps.providerCnpj),
      tag('xNome', provider.legalName),
      '<enderNac>',
      tag('xLgr', provider.address.street),
      tag('nro', provider.address.number),
      tag('xBairro', provider.address.district),
      tag('cMun', provider.address.municipalityCode),
      tag('UF', provider.address.uf),
      tag('CEP', provider.address.postalCode),
      '</enderNac>',
      '</emit>',
      '<valores>',
      tag('vBC', generation.serviceAmount),
      tag('pAliqAplic', generation.issRate),
      tag('vISSQN', generation.issAmount),
      tag('vLiq', generation.serviceAmount),
      '</valores>',
      '<IBSCBS>',
      tag('cLocalidadeIncid', dps.placeMunicipality),
      tag('xLocalidadeIncid', place.name),
      '<valores>',
      tag('vBC', generation.serviceAmount),
      '<uf>',
      tag('pIBSUF', percent(this.ibsCbs.ibsUf)),
      tag('pAliqEfetUF', percent(this.ibsCbs.ibsUf)),
      '</uf>',
      '<mun>',
      tag('pIBSMun', percent(this.ibsCbs.ibsMun)),
      tag('pAliqEfetMun', percent(this.ibsCbs.ibsMun)),
      '</mun>',
      '<fed>',
      tag('pCBS', percent(this.ibsCbs.cbs)),
      tag('pAliqEfetCBS', percent(this.ibsCbs.cbs)),
      '</fed>',
      '</valores>',
      '<totCIBS>',
      tag('vTotNF', generation.serviceAmount),
      '<gIBS>',
      tag('vIBSTot', ibsTotal),
      '<gIBSUFTot>',
      tag('vIBSUF', generation.ibsUfAmount),
      '</gIBSUFTot>',
      '<gIBSMunTot>',
      tag('vIBSMun', generation.ibsMunAmount),
      '</gIBSMunTot>',
      '</gIBS>',
      '<gCBS>',
      tag('vCBS', generation.cbsAmount),
      '</gCBS>',
      '</totCIBS>',
      '</IBSCBS>',
      dpsElement.replace(` xmlns="${NFSE_NAMESPACE}"`, ''),
      '</infNFSe>',
      '</NFSe>',
    ].join('')
    return Buffer.from(body, 'utf8')
  }

  /** Event 105102, registered by the national system when a substitute is generated. */
  private substitutionEvent(dps: Dps, generation: NfseGeneration): Buffer {
    const replaced = generation.substitutedKey
    if (!replaced || !dps.substitutionReason) throw new Error('Substitution facts are missing')
    const request = [
      `<pedRegEvento versao="${NFSE_LAYOUT_VERSION}">`,
      `<infPedReg Id="PRE${replaced}${NFSE_SUBSTITUTION_EVENT}">`,
      tag('tpAmb', '2'),
      tag('verAplic', APPLICATION),
      tag('dhEvento', generation.processedAt),
      tag('CNPJAutor', dps.providerCnpj),
      tag('chNFSe', replaced),
      `<e${NFSE_SUBSTITUTION_EVENT}>`,
      tag('xDesc', 'Cancelamento de NFS-e por Substituição'),
      tag('cMotivo', dps.substitutionReason.code),
      dps.substitutionReason.text ? tag('xMotivo', dps.substitutionReason.text) : '',
      tag('chSubstituta', generation.nfseKey),
      `</e${NFSE_SUBSTITUTION_EVENT}>`,
      '</infPedReg>',
      '</pedRegEvento>',
    ].join('')
    return this.event(replaced, NFSE_SUBSTITUTION_EVENT, generation.processedAt, request)
  }

  private decideCancellation(
    request: z.infer<typeof eventRequestSchema>,
    scenario: SimulatorScenario,
    eventXml: Buffer,
    nfseXml: Buffer,
  ): NfseEventSimulatorResult {
    if (scenario === 'rejected')
      return this.eventEnvelope(request, scenario, 'rejected', 'SIMULATED_REJECTION', null)
    const event = readEvent(eventXml)
    const nfse = readNfse(nfseXml)
    if (event.nfseKey !== nfse.nfseKey)
      return this.eventEnvelope(request, scenario, 'rejected', 'E1840', null)
    const municipality = this.#municipalities.get(nfse.nfseKey.slice(0, 7))
    const registeredAt =
      scenario === 'timeout-before-accept' ? this.now() : promptEvent(event.occurredAt, request)
    if (
      !municipality ||
      registeredAt.getTime() - Date.parse(nfse.processedAt) >
        municipality.cancellationWindowDays * 86_400_000
    )
      return this.eventEnvelope(request, scenario, 'rejected', 'E0822', null)
    const request105 = eventXml
      .toString('utf8')
      .replace(/^<\?xml[^>]*\?>/, '')
      .trim()
      .replace(` xmlns="${NFSE_NAMESPACE}"`, '')
    const protocol = this.event(
      nfse.nfseKey,
      NFSE_CANCELLATION_EVENT,
      localInstant(registeredAt),
      request105,
    )
    return this.eventEnvelope(request, scenario, 'cancelled', null, protocol)
  }

  /** `evento` 1.01: the registered event wrapping the request, signed by the system. */
  private event(key: string, type: string, processedAt: string, pedRegEvento: string): Buffer {
    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<evento xmlns="${NFSE_NAMESPACE}" versao="${NFSE_LAYOUT_VERSION}">`,
      `<infEvento Id="EVT${key}${type}001">`,
      tag('verAplic', APPLICATION),
      tag('ambGer', '2'),
      tag('nSeqEvento', '1'),
      tag('dhProc', processedAt),
      tag(
        'nDFSe',
        String((BigInt(`0x${sha256(Buffer.from(key + type)).slice(0, 10)}`) % 10n ** 12n) + 1n),
      ),
      pedRegEvento,
      '</infEvento>',
      '</evento>',
    ].join('')
    return signNfseElement(Buffer.from(body, 'utf8'), 'infEvento', this.credential)
  }

  private envelope(
    request: Request,
    scenario: SimulatorScenario,
    outcome: NfseSimulatorResult['outcome'],
    rejectionCode: string | null,
    dps: Dps,
    generation: NfseGeneration | null,
    nfseXml: Buffer | null = null,
    substitutionEvent: Buffer | null = null,
  ): NfseSimulatorResult {
    const decided = outcome === 'authorized' || outcome === 'rejected'
    const providerCorrelation = decided ? correlation('nfse', request.commandId) : null
    const response = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        simulated: true,
        model: 'nfse',
        synchronous: true,
        scenario,
        commandId: request.commandId,
        requestDigest: request.requestDigest,
        idDps: dps.dpsId,
        outcome,
        rejectionCode,
        chaveAcesso: generation?.nfseKey ?? null,
        dhProc: generation?.processedAt ?? null,
        nfseXmlDigest: nfseXml ? sha256(nfseXml) : null,
        providerCorrelation,
      }),
    )
    return {
      outcome,
      providerCorrelation,
      rejectionCode,
      response,
      nfseXml,
      generation,
      substitutionEvent,
    }
  }

  private eventEnvelope(
    request: z.infer<typeof eventRequestSchema>,
    scenario: SimulatorScenario,
    outcome: NfseEventSimulatorResult['outcome'],
    rejectionCode: string | null,
    protocol: Buffer | null,
  ): NfseEventSimulatorResult {
    const decided = outcome === 'cancelled' || outcome === 'rejected'
    const providerCorrelation = decided ? correlation('nfse-event', request.commandId) : null
    return {
      outcome,
      providerCorrelation,
      rejectionCode,
      protocol,
      response: Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          simulated: true,
          model: 'nfse',
          event: NFSE_CANCELLATION_EVENT,
          scenario,
          commandId: request.commandId,
          requestDigest: request.requestDigest,
          outcome,
          rejectionCode,
          eventXmlDigest: protocol ? sha256(protocol) : null,
          providerCorrelation,
        }),
      ),
    }
  }
}

function readDps(signedDps: Buffer) {
  const document = new DOMParser().parseFromString(signedDps.toString('utf8'), 'application/xml')
  const infDps = document.getElementsByTagName('infDPS').item(0)
  if (!infDps) throw new Error('Simulated DPS lacks infDPS')
  const read = (name: string, required = true): string => {
    const value = infDps.getElementsByTagName(name).item(0)?.textContent?.trim() ?? ''
    if (required && !value) throw new Error(`Simulated DPS lacks ${name}`)
    return value
  }
  const signature = document.getElementsByTagName('Signature').item(0)
  const verifier = new SignedXml({ getCertFromKeyInfo: SignedXml.getCertFromKeyInfo })
  if (!signature) throw new Error('Simulated DPS is not signed (E0717)')
  verifier.loadSignature(signature as unknown as Node)
  if (!verifier.checkSignature(signedDps.toString('utf8')))
    throw new Error('Simulated DPS signature is invalid (E0714)')
  const substitutedKey = read('chSubstda', false) || null
  return {
    dpsId: infDps.getAttribute('Id') ?? '',
    environment: read('tpAmb'),
    issuedAt: read('dhEmi'),
    series: Number(read('serie')),
    number: Number(read('nDPS')),
    competenceDate: read('dCompet'),
    issuingMunicipality: read('cLocEmi'),
    providerCnpj: read('CNPJ'),
    placeMunicipality: read('cLocPrestacao'),
    nationalTaxCode: read('cTribNac'),
    nbsCode: read('cNBS', false) || null,
    serviceAmount: read('vServ'),
    hasRate: read('pAliq', false) !== '',
    substitutedKey,
    substitutionReason: substitutedKey
      ? { code: read('cMotivo'), text: read('xMotivo', false) || null }
      : null,
  }
}

function readEvent(eventXml: Buffer) {
  const document = new DOMParser().parseFromString(eventXml.toString('utf8'), 'application/xml')
  const value = (name: string) =>
    document.getElementsByTagName(name).item(0)?.textContent?.trim() ?? ''
  return { nfseKey: value('chNFSe'), occurredAt: value('dhEvento') }
}

export function readNfse(nfseXml: Buffer): { nfseKey: string; processedAt: string } {
  const document = new DOMParser().parseFromString(nfseXml.toString('utf8'), 'application/xml')
  const info = document.getElementsByTagName('infNFSe').item(0)
  const processedAt = info?.getElementsByTagName('dhProc').item(0)?.textContent?.trim() ?? ''
  const nfseKey = (info?.getAttribute('Id') ?? '').replace(/^NFS/, '')
  if (!isNfseKey(nfseKey) || !processedAt) throw new Error('Simulated NFS-e is incomplete')
  return { nfseKey, processedAt }
}

/** A DPS received on its first send is processed within a minute of `dhEmi`. */
function promptProcessing(issuedAt: string, request: Request): Date {
  const seconds = createHash('sha256').update(request.commandId).digest().readUInt8(0) % 60
  return new Date(Date.parse(issuedAt) + (seconds + 1) * 1000)
}

function promptEvent(occurredAt: string, request: { commandId: string }): Date {
  const seconds = createHash('sha256').update(request.commandId).digest().readUInt8(1) % 30
  return new Date(Date.parse(occurredAt) + (seconds + 1) * 1000)
}

/** The simulated system answers in Brasília time (UTC−03:00). */
function localInstant(instant: Date): string {
  const shifted = new Date(instant.getTime() - 3 * 3_600_000)
  return `${shifted.toISOString().slice(0, 19)}-03:00`
}

function cents(value: string): bigint {
  const [integer = '0', fraction = ''] = value.split('.')
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
}

function fromCents(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`
}

/** Half away from zero, on non-negative amounts. */
function apply(base: bigint, rate: { numerator: string; denominator: string }): bigint {
  const numerator = base * BigInt(rate.numerator) * 2n
  const denominator = BigInt(rate.denominator) * 2n
  return (numerator + denominator / 2n) / denominator
}

/** `TSDec2V2`/`TSDec1V2` percentages: 2/100 → "2.00". */
function percent(rate: { numerator: string; denominator: string }): string {
  const hundredths = (BigInt(rate.numerator) * 10_000n) / BigInt(rate.denominator)
  if (hundredths === 0n) return '0'
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`
}

function digits(seed: string, length: number): string {
  return sha256(Buffer.from(seed))
    .slice(0, length)
    .split('')
    .map((digit) => String(Number.parseInt(digit, 16) % 10))
    .join('')
}

function correlation(kind: string, commandId: string): string {
  return `simulation:${kind}:${sha256(Buffer.from(commandId)).slice(0, 32)}`
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function defaultScenario(requestDigest: string): SimulatorScenario {
  const bucket = Number.parseInt(requestDigest.at(-1) ?? '0', 16)
  if (bucket === 12) return 'timeout-before-accept'
  if (bucket === 13) return 'timeout-after-accept'
  if (bucket === 14) return 'delayed-consultation'
  if (bucket === 15) return 'rejected'
  return 'authorized'
}
