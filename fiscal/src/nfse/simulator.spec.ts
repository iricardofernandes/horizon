import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SimulationCredential } from '../nfe55/signature'
import type { SimulatorScenario } from '../nfe55/simulator'
import { serializeCancellationRequest } from './event'
import { isNfseKey } from './identifiers'
import { validateNfseSchema } from './schema'
import { signNfseElement, verifyNfseElement } from './signature'
import { DeterministicNfseSimulator, type NfseMunicipalParameters, readNfse } from './simulator'
import { dpsFixture, NFSE_SCHEMA_PATH, PROVIDER_CNPJ, simulationCredential } from './spec-fixture'
import { serializeDps } from './xml'

let credential: SimulationCredential
let dispose: () => Promise<void>
let schemaZip: Buffer

const saoPaulo: NfseMunicipalParameters = {
  municipalityCode: '3550308',
  agreement: 'active',
  nationalIssuer: true,
  startsOn: '2025-12-22',
  issRates: { '010101': { numerator: '2', denominator: '100' } },
  cancellationWindowDays: 30,
}
const campinas: NfseMunicipalParameters = {
  ...saoPaulo,
  municipalityCode: '3509502',
  nationalIssuer: false,
  startsOn: '2025-11-16',
}
const rates = {
  cbs: { numerator: '9', denominator: '1000' },
  ibsUf: { numerator: '1', denominator: '1000' },
  ibsMun: { numerator: '0', denominator: '1' },
}
const provider = {
  legalName: 'Horizon Serviços Ltda',
  address: {
    street: 'Rua do Café',
    number: '42',
    district: 'Centro',
    municipalityCode: '3550308',
    uf: 'SP',
    postalCode: '01001000',
  },
}

beforeAll(async () => {
  ;({ credential, dispose } = await simulationCredential())
  schemaZip = await readFile(NFSE_SCHEMA_PATH)
})
afterAll(async () => dispose?.())

function simulator(
  scenario: SimulatorScenario = 'authorized',
  now = new Date('2026-09-26T14:00:00Z'),
) {
  return new DeterministicNfseSimulator(
    [saoPaulo, campinas],
    rates,
    credential,
    () => scenario,
    () => now,
  )
}

function request(signedDps: Buffer, attemptCount = 1) {
  return {
    commandId: '0199a5f0-0000-7000-8000-000000000001',
    requestDigest: 'a'.repeat(64),
    dpsDigest: createHash('sha256').update(signedDps).digest('hex'),
    attemptCount,
    signedDps,
    provider,
  }
}

const signed = (overrides: Parameters<typeof dpsFixture>[0] = {}) =>
  signNfseElement(serializeDps(dpsFixture(overrides)), 'infDPS', credential)

describe('simulated Sefin Nacional', () => {
  it('generates a schema-valid, signed NFS-e with the municipal ISS and RTC rates', async () => {
    const dps = signed()
    const result = await simulator().submit(request(dps))
    expect(result.outcome).toBe('authorized')
    expect(result.nfseXml).not.toBeNull()
    const nfse = result.nfseXml as Buffer
    await validateNfseSchema({ xml: nfse, root: 'NFSe', schemaZip })
    verifyNfseElement(nfse, 'infNFSe', credential.certificate)
    // The DPS travels unchanged inside the NFS-e, still verifiable.
    verifyNfseElement(nfse, 'infDPS', credential.certificate)
    expect(result.generation).toMatchObject({
      nfseNumber: '1',
      issRate: '2.00',
      issAmount: '30.00',
      cbsAmount: '13.50',
      ibsUfAmount: '1.50',
      ibsMunAmount: '0.00',
      substitutedKey: null,
    })
    expect(isNfseKey(result.generation?.nfseKey ?? '')).toBe(true)
    expect(readNfse(nfse).nfseKey).toBe(result.generation?.nfseKey)
    // Replaying the same command gives the same bytes.
    const again = await simulator().submit(request(dps))
    expect(again.nfseXml?.equals(nfse)).toBe(true)
  })

  it('rejects a naive resend of a DPS it generated (E0014); consultation finds it', async () => {
    const dps = signed()
    const lost = simulator('timeout-after-accept')
    expect((await lost.submit(request(dps))).outcome).toBe('unknown')
    const resent = await lost.submit(request(dps, 2))
    expect(resent).toMatchObject({ outcome: 'rejected', rejectionCode: 'E0014' })
    const consulted = await lost.consult(request(dps, 2))
    expect(consulted.outcome).toBe('authorized')
    const prompt = await simulator().submit(request(dps))
    expect(consulted.generation?.nfseKey).toBe(prompt.generation?.nfseKey)
  })

  it('generates a DPS it never received only when it is sent again', async () => {
    const dps = signed()
    const now = new Date('2026-09-26T13:30:00Z')
    const lost = simulator('timeout-before-accept', now)
    expect((await lost.submit(request(dps))).outcome).toBe('unknown')
    expect((await lost.consult(request(dps, 2))).outcome).toBe('not_found')
    const resent = await lost.submit(request(dps, 2))
    expect(resent.outcome).toBe('authorized')
    expect(resent.generation?.processedAt).toBe('2026-09-26T10:30:00-03:00')
  })

  it('refuses a municipality without the national issuer and a stated ISS rate', async () => {
    const campinasDps = signed({
      dpsId: `DPS35095022${PROVIDER_CNPJ}00001000000000000001`,
      issuingMunicipality: '3509502',
      service: { ...dpsFixture().service, placeMunicipality: '3509502' },
    })
    expect(await simulator().submit(request(campinasDps))).toMatchObject({
      outcome: 'rejected',
      rejectionCode: 'E0039',
    })
    const rioDps = signed({
      dpsId: `DPS33045572${PROVIDER_CNPJ}00001000000000000001`,
      issuingMunicipality: '3304557',
    })
    expect((await simulator().submit(request(rioDps))).rejectionCode).toBe('E0037')
    const early = signed({ competenceDate: '2025-12-01', issuedAt: '2025-12-10T10:00:00-03:00' })
    expect((await simulator().submit(request(early))).rejectionCode).toBe('E0016')
    const withRate = signNfseElement(
      Buffer.from(
        serializeDps(dpsFixture())
          .toString()
          .replace('<tpRetISSQN>1</tpRetISSQN>', '<tpRetISSQN>1</tpRetISSQN><pAliq>2.00</pAliq>'),
      ),
      'infDPS',
      credential,
    )
    expect((await simulator().submit(request(withRate))).rejectionCode).toBe('E0617')
  })

  it('cancels with event 101101 inside the municipal window only', async () => {
    const generated = await simulator().submit(request(signed()))
    const nfseXml = generated.nfseXml as Buffer
    const key = generated.generation?.nfseKey as string
    const event = (occurredAt: string) =>
      signNfseElement(
        serializeCancellationRequest({
          nfseKey: key,
          authorCnpj: PROVIDER_CNPJ,
          occurredAt,
          applicationVersion: 'horizon-phase47',
          reasonCode: '1',
          reason: 'Erro na emissão do documento',
        }),
        'infPedReg',
        credential,
      )
    const cancel = (xml: Buffer) =>
      simulator().submitCancellation({
        commandId: '0199a5f0-0000-7000-8000-000000000002',
        requestDigest: 'b'.repeat(64),
        eventXmlDigest: createHash('sha256').update(xml).digest('hex'),
        attemptCount: 1,
        eventXml: xml,
        nfseXml,
      })
    const inside = await cancel(event('2026-09-27T09:00:00-03:00'))
    expect(inside.outcome).toBe('cancelled')
    await validateNfseSchema({ xml: inside.protocol as Buffer, root: 'evento', schemaZip })
    verifyNfseElement(inside.protocol as Buffer, 'infEvento', credential.certificate)
    expect((inside.protocol as Buffer).toString()).toContain(`Id="EVT${key}101101001"`)
    const late = await cancel(event('2026-11-30T09:00:00-03:00'))
    expect(late).toMatchObject({ outcome: 'rejected', rejectionCode: 'E0822', protocol: null })
  })

  it('registers event 105102 on the original when a substitute is generated', async () => {
    const original = await simulator().submit(request(signed()))
    const replacedKey = original.generation?.nfseKey as string
    const substitute = signed({
      number: 2,
      dpsId: `DPS35503082${PROVIDER_CNPJ}00001000000000000002`,
      values: { ...dpsFixture().values, serviceAmount: '1200.00' },
      substitution: { replacedKey, reasonCode: '99', reason: 'Valor do serviço revisado' },
    })
    const result = await simulator().submit(request(substitute))
    expect(result.outcome).toBe('authorized')
    expect(result.generation?.substitutedKey).toBe(replacedKey)
    const event = result.substitutionEvent as Buffer
    await validateNfseSchema({ xml: event, root: 'evento', schemaZip })
    expect(event.toString()).toContain(`<chSubstituta>${result.generation?.nfseKey}</chSubstituta>`)
    expect(event.toString()).toContain(`Id="EVT${replacedKey}105102001"`)
    const wrongKey = signed({
      number: 3,
      dpsId: `DPS35503082${PROVIDER_CNPJ}00001000000000000003`,
      substitution: { replacedKey: `${'1'.repeat(49)}0`, reasonCode: '01', reason: null },
    })
    expect((await simulator().submit(request(wrongKey))).rejectionCode).toBe('E0042')
  })
})
