import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DOMParser } from '@xmldom/xmldom'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateNfe55Schema } from '../nfe55/schema'
import { type SimulationCredential, verifyNfe55Signature } from '../nfe55/signature'
import { onlineQrCodeV3, parseOnlineQrCodeV3, SIMULATION_QR_URL } from './qr-code'
import { signNfce65 } from './signature'
import { accessKey, nfceFixture } from './spec-fixture'
import { serializeNfce65 } from './xml'

const SCHEMA_DIGEST = 'b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998'
const SCHEMA_PATH = new URL('../../fixtures/official/pl-010f-v1.04.zip', import.meta.url)

let credential: SimulationCredential
let credentialDirectory: string

beforeAll(async () => {
  credentialDirectory = await mkdtemp(join(tmpdir(), 'horizon-phase46-credential-'))
  const keyPath = join(credentialDirectory, 'simulation-only.key.pem')
  const certificatePath = join(credentialDirectory, 'simulation-only.cert.pem')
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '1',
    '-subj',
    '/CN=Horizon Phase 46 Simulation Only',
    '-keyout',
    keyPath,
    '-out',
    certificatePath,
  ])
  credential = {
    privateKey: await readFile(keyPath),
    certificate: await readFile(certificatePath),
  }
})

afterAll(async () => {
  if (credentialDirectory) await rm(credentialDirectory, { recursive: true, force: true })
})

describe('NFC-e model 65 XML', () => {
  it('validates the signed model 65 XML with its QR code against PL 010f', async () => {
    const unsigned = serializeNfce65(nfceFixture())
    expect(serializeNfce65(nfceFixture())).toEqual(unsigned)
    const signed = signNfce65(unsigned, credential)
    verifyNfe55Signature(signed, credential.certificate)
    await validateNfe55Schema({
      xml: signed,
      schemaZip: await readFile(SCHEMA_PATH),
      expectedZipDigest: SCHEMA_DIGEST,
    })
    const document = new DOMParser().parseFromString(signed.toString(), 'application/xml')
    const text = (name: string) => document.getElementsByTagName(name).item(0)?.textContent
    expect(text('mod')).toBe('65')
    expect(text('tpImp')).toBe('4')
    expect(text('indFinal')).toBe('1')
    expect(text('indPres')).toBe('4')
    expect(text('indIntermed')).toBe('0')
    expect(text('indIEDest')).toBe('9')
    expect(text('CPF')).toBe('12345678909')
    expect(document.getElementsByTagName('IE').length).toBe(1) // only the issuer's
    expect(text('tPag')).toBe('05')
    expect(text('qrCode')).toBe(nfceFixture().supplement.qrCode)
  })

  it('signs infNFe only and places the signature after infNFeSupl', () => {
    const signed = signNfce65(serializeNfce65(nfceFixture()), credential).toString()
    expect(signed.indexOf('</infNFeSupl><Signature')).toBeGreaterThan(0)
    const reference = verifyNfe55Signature(Buffer.from(signed), credential.certificate).toString()
    expect(reference).toContain('<infNFe')
    expect(reference).not.toContain('infNFeSupl')
    // The supplementary group is outside the signature: changing it keeps the signature
    // valid, which is why the QR code is rebuilt from the key and never trusted as input.
    expect(() =>
      verifyNfe55Signature(
        Buffer.from(signed.replace('/qrcode?p=', '/other?p=')),
        credential.certificate,
      ),
    ).not.toThrow()
    expect(() =>
      verifyNfe55Signature(
        Buffer.from(signed.replace('<tPag>05</tPag>', '<tPag>01</tPag>')),
        credential.certificate,
      ),
    ).toThrow('invalid')
  })

  it('refuses a model 55 key, contingency, a foreign QR code and a delivery without address', () => {
    const base = nfceFixture()
    const key55 = accessKey({ model: '55' })
    expect(() => serializeNfce65({ ...base, accessKey: key55 })).toThrow('model 65')
    expect(() =>
      serializeNfce65({
        ...base,
        supplement: {
          ...base.supplement,
          qrCode: `${SIMULATION_QR_URL}?p=${accessKey({ number: 2 })}|3|2`,
        },
      }),
    ).toThrow('version 3 online QR code')
    const consumer = base.consumer
    if (!consumer) throw new Error('fixture consumer missing')
    expect(() => serializeNfce65({ ...base, consumer: { ...consumer, address: null } })).toThrow(
      'delivery address',
    )
    expect(() =>
      serializeNfce65({ ...base, payment: { ...base.payment, amount: '99.00' } }),
    ).toThrow('invoice total')
    expect(() =>
      onlineQrCodeV3({ queryUrl: SIMULATION_QR_URL, accessKey: key55, environment: '2' }),
    ).toThrow('model 65')
    expect(() =>
      onlineQrCodeV3({
        queryUrl: SIMULATION_QR_URL,
        accessKey: accessKey({ emissionType: 9 }),
        environment: '2',
      }),
    ).toThrow('online')
  })

  it('prints an unidentified consumer without dest when the sale is in person', async () => {
    const signed = signNfce65(
      serializeNfce65({ ...nfceFixture(), presence: '1', consumer: null }),
      credential,
    )
    expect(signed.toString()).not.toContain('<dest>')
    expect(signed.toString()).not.toContain('indIntermed')
    await validateNfe55Schema({
      xml: signed,
      schemaZip: await readFile(SCHEMA_PATH),
      expectedZipDigest: SCHEMA_DIGEST,
    })
  })

  it('builds the version 3 online QR code without CSC and reads it back', () => {
    const key = accessKey({})
    const qrCode = onlineQrCodeV3({ queryUrl: SIMULATION_QR_URL, accessKey: key, environment: '2' })
    expect(qrCode).toBe(`https://nfce.simulacao.horizon.invalid/qrcode?p=${key}|3|2`)
    expect(parseOnlineQrCodeV3(qrCode)).toEqual({
      queryUrl: SIMULATION_QR_URL,
      accessKey: key,
      version: '3',
      environment: '2',
    })
    expect(parseOnlineQrCodeV3(`${qrCode}|99`)).toBeNull()
  })
})
