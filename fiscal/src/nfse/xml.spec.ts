import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SimulationCredential } from '../nfe55/signature'
import { serializeCancellationRequest } from './event'
import { buildDpsId, buildNfseKey, isNfseKey, parseDpsId } from './identifiers'
import { validateNfseSchema } from './schema'
import { signNfseElement, verifyNfseElement } from './signature'
import { dpsFixture, NFSE_SCHEMA_PATH, PROVIDER_CNPJ, simulationCredential } from './spec-fixture'
import { serializeDps } from './xml'

let credential: SimulationCredential
let dispose: () => Promise<void>

beforeAll(async () => {
  ;({ credential, dispose } = await simulationCredential())
})
afterAll(async () => dispose?.())

describe('national NFS-e DPS', () => {
  it('validates the signed DPS against the pinned layout 1.01 schema', async () => {
    const unsigned = serializeDps(dpsFixture())
    expect(serializeDps(dpsFixture())).toEqual(unsigned)
    const signed = signNfseElement(unsigned, 'infDPS', credential)
    const authenticated = verifyNfseElement(signed, 'infDPS', credential.certificate)
    expect(authenticated.toString()).toContain('<cTribNac>010101</cTribNac>')
    await validateNfseSchema({
      xml: signed,
      root: 'DPS',
      schemaZip: await readFile(NFSE_SCHEMA_PATH),
    })
    const xml = signed.toString()
    // E0617: a non-Simples provider in an active municipality never states the ISSQN rate.
    expect(xml).not.toContain('<pAliq>')
    expect(xml).toContain('<opSimpNac>1</opSimpNac>')
    expect(xml).toContain('<cIndOp>100301</cIndOp>')
    expect(xml.indexOf('</infDPS><Signature')).toBeGreaterThan(0)
  })

  it('carries the substitution group and rejects a tampered DPS', async () => {
    const key = buildNfseKey({
      municipalityCode: '3550308',
      generatingEnvironment: '2',
      cnpj: PROVIDER_CNPJ,
      nfseNumber: 7,
      yearMonth: '2609',
      numericCode: '123456789',
    })
    const unsigned = serializeDps(
      dpsFixture({
        number: 2,
        substitution: { replacedKey: key, reasonCode: '01', reason: null },
      }),
    )
    const signed = signNfseElement(unsigned, 'infDPS', credential)
    await validateNfseSchema({
      xml: signed,
      root: 'DPS',
      schemaZip: await readFile(NFSE_SCHEMA_PATH),
    })
    expect(signed.toString()).toContain(
      `<subst><chSubstda>${key}</chSubstda><cMotivo>01</cMotivo></subst>`,
    )
    const tampered = Buffer.from(signed.toString().replace('1500.00', '1.00'))
    expect(() => verifyNfseElement(tampered, 'infDPS', credential.certificate)).toThrow(/invalid/)
  })

  it('refuses facts the national rules reject before sending', () => {
    expect(() => serializeDps(dpsFixture({ dpsId: `DPS${'0'.repeat(42)}` }))).toThrow(/E0004/)
    expect(() => serializeDps(dpsFixture({ competenceDate: '2026-10-01' }))).toThrow(/E0015/)
    expect(() =>
      serializeDps(
        dpsFixture({
          service: { ...dpsFixture().service, nationalTaxCode: '999999' },
        }),
      ),
    ).toThrow(/national list/)
    expect(() =>
      serializeDps(dpsFixture({ service: { ...dpsFixture().service, nbsCode: '999999999' } })),
    ).toThrow(/NBS/)
  })

  it('builds identifiers per Anexo I', () => {
    const id = buildDpsId({
      municipalityCode: '3550308',
      cnpj: PROVIDER_CNPJ,
      series: 1,
      number: 42,
    })
    expect(id).toBe(`DPS35503082${PROVIDER_CNPJ}00001000000000000042`)
    expect(id).toHaveLength(45)
    expect(parseDpsId(id)).toMatchObject({ series: 1, number: 42, inscriptionType: '2' })
    expect(() =>
      buildDpsId({ municipalityCode: '3550308', cnpj: PROVIDER_CNPJ, series: 50_000, number: 1 }),
    ).toThrow(/range/)
    const key = buildNfseKey({
      municipalityCode: '3550308',
      generatingEnvironment: '2',
      cnpj: PROVIDER_CNPJ,
      nfseNumber: 1,
      yearMonth: '2609',
      numericCode: '000000001',
    })
    expect(key).toHaveLength(50)
    expect(isNfseKey(key)).toBe(true)
    expect(isNfseKey(`${key.slice(0, 49)}${(Number(key.at(-1)) + 1) % 10}`)).toBe(false)
  })

  it('validates the signed cancellation request (event 101101)', async () => {
    const nfseKey = buildNfseKey({
      municipalityCode: '3550308',
      generatingEnvironment: '2',
      cnpj: PROVIDER_CNPJ,
      nfseNumber: 1,
      yearMonth: '2609',
      numericCode: '000000001',
    })
    const unsigned = serializeCancellationRequest({
      nfseKey,
      authorCnpj: PROVIDER_CNPJ,
      occurredAt: '2026-09-26T11:00:00-03:00',
      applicationVersion: 'horizon-phase47',
      reasonCode: '2',
      reason: 'Serviço não foi prestado ao cliente',
    })
    const signed = signNfseElement(unsigned, 'infPedReg', credential)
    verifyNfseElement(signed, 'infPedReg', credential.certificate)
    await validateNfseSchema({
      xml: signed,
      root: 'pedRegEvento',
      schemaZip: await readFile(NFSE_SCHEMA_PATH),
    })
    expect(signed.toString()).toContain(`Id="PRE${nfseKey}101101"`)
  })
})
