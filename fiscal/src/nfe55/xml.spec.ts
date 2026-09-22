import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Nfe55Data } from './model'
import { validateNfe55Schema } from './schema'
import { type SimulationCredential, signNfe55, verifyNfe55Signature } from './signature'
import { serializeNfe55 } from './xml'

const SCHEMA_DIGEST = 'b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998'
const SCHEMA_PATH = new URL('../../fixtures/official/pl-010f-v1.04.zip', import.meta.url)

let credential: SimulationCredential
let credentialDirectory: string

beforeAll(async () => {
  credentialDirectory = await mkdtemp(join(tmpdir(), 'horizon-phase42-credential-'))
  const keyPath = join(credentialDirectory, 'simulation-only.key.pem')
  const certificatePath = join(credentialDirectory, 'simulation-only.cert.pem')
  await promisify(execFile)(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '1',
      '-subj',
      '/CN=Horizon Phase 42 Simulation Only',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
    ],
    { windowsHide: true },
  )
  credential = {
    privateKey: await readFile(keyPath),
    certificate: await readFile(certificatePath),
  }
})

afterAll(async () => {
  if (credentialDirectory) await rm(credentialDirectory, { recursive: true, force: true })
})

describe('NF-e 4.00 XML and simulation signature', () => {
  it('serializes stable UTF-8 bytes and validates the signed XML against PL 010f', async () => {
    const first = serializeNfe55(fixture())
    const second = serializeNfe55(fixture())
    expect(second).toEqual(first)
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      'dfa305ed61e391add469a998d34b9a57de01cee7f905e855dda7966c7adf01a0',
    )
    expect(first.toString()).toContain('Café torrado em grãos')

    const signed = signNfe55(first, credential)
    expect(verifyNfe55Signature(signed, credential.certificate).toString()).toContain(
      'Id="NFe35260900000000E08G12550010000000011123456783"',
    )
    await validateNfe55Schema({
      xml: signed,
      schemaZip: await readFile(SCHEMA_PATH),
      expectedZipDigest: SCHEMA_DIGEST,
    })
  })

  it('fails closed on digest, schema and signed-byte mutations', async () => {
    const unsigned = serializeNfe55(fixture())
    const signed = signNfe55(unsigned, credential)
    await expect(
      validateNfe55Schema({
        xml: signed,
        schemaZip: await readFile(SCHEMA_PATH),
        expectedZipDigest: '0'.repeat(64),
      }),
    ).rejects.toThrow('digest mismatch')
    await expect(
      validateNfe55Schema({
        xml: Buffer.from(signed.toString().replace('<mod>55</mod>', '')),
        schemaZip: await readFile(SCHEMA_PATH),
        expectedZipDigest: SCHEMA_DIGEST,
      }),
    ).rejects.toThrow('schema validation failed')
    expect(() =>
      verifyNfe55Signature(
        Buffer.from(signed.toString().replace('<vProd>100.00</vProd>', '<vProd>100.01</vProd>')),
        credential.certificate,
      ),
    ).toThrow('signature is invalid')
  })

  it('rejects inconsistent access-key fields before producing XML', () => {
    expect(() => serializeNfe55({ ...fixture(), number: 2 })).toThrow('does not match access key')
    expect(() =>
      serializeNfe55({
        ...fixture(),
        totals: { ...fixture().totals, products: '99.99' },
      }),
    ).toThrow('does not reconcile with frozen lines')
  })
})

function fixture(): Nfe55Data {
  const address = {
    street: 'Rua do Café',
    number: '42',
    complement: null,
    district: 'Centro',
    municipalityCode: '3550308',
    city: 'São Paulo',
    state: 'SP',
    postalCode: '01001000',
  } as const
  return {
    accessKey: '35260900000000E08G12550010000000011123456783',
    issuedAt: '2026-09-22T12:00:00-03:00',
    natureOperation: 'Venda de café torrado',
    numericCode: '12345678',
    series: 1,
    number: 1,
    issuer: {
      taxId: '00000000E08G12',
      legalName: 'Horizon Café Simulação LTDA',
      stateRegistration: '123456789',
      address,
    },
    recipient: {
      taxId: '11222333000181',
      legalName: 'Cliente Simulado LTDA',
      stateRegistration: '987654321',
      address: { ...address, street: 'Avenida Paulista', number: '1000' },
    },
    lines: [
      {
        number: 1,
        productCode: 'CAFE-001',
        description: 'Café torrado em grãos',
        ncm: '09012100',
        cfop: '5102',
        unit: 'UN',
        quantity: '1.0000',
        unitPrice: '100.00',
        gross: '100.00',
        discount: '0.00',
        other: '0.00',
        ibsCbs: {
          cst: '000',
          classification: '000001',
          base: '100.00',
          ibsUfRate: '0.1000',
          ibsUfValue: '0.10',
          ibsMunicipalRate: '0.0000',
          ibsMunicipalValue: '0.00',
          cbsRate: '0.9000',
          cbsValue: '0.90',
        },
      },
    ],
    totals: {
      products: '100.00',
      discounts: '0.00',
      other: '0.00',
      invoice: '100.00',
      ibsUf: '0.10',
      ibsMunicipal: '0.00',
      ibs: '0.10',
      cbs: '0.90',
      ibsCbsBase: '100.00',
      invoiceWithIbsCbs: '101.00',
    },
  }
}
