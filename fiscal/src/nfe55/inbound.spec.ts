import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  signedSupplierInvoice,
  supplierCredential,
  supplierInvoice,
  withProtocol,
} from '../../test/support/inbound-nfe'
import { type InboundRejectionCode, verifyInboundNfe55 } from './inbound'
import type { SimulationCredential } from './signature'
import { signNfe55 } from './signature'

const SCHEMA_DIGEST = 'b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998'
const SCHEMA_PATH = new URL('../../fixtures/official/pl-010f-v1.04.zip', import.meta.url)
const SUPPLIER = '12345678000195'
const BUYER = '98765432000100'

let directory: string
let supplier: SimulationCredential
let stranger: SimulationCredential
let schemaZip: Buffer

const invoice = (overrides: Partial<Parameters<typeof supplierInvoice>[0]> = {}) => ({
  supplierTaxId: SUPPLIER,
  recipientTaxId: BUYER,
  number: 101,
  lines: [
    {
      productCode: 'GR-01',
      description: 'Grão verde',
      ncm: '09011110',
      quantity: '6',
      unitPrice: '10.00',
    },
    {
      productCode: 'SC-02',
      description: 'Saco de juta',
      ncm: '63051000',
      quantity: '2',
      unitPrice: '3.50',
    },
  ],
  ...overrides,
})

const verify = (xml: Buffer, recipientTaxId = BUYER) =>
  verifyInboundNfe55({ xml, recipientTaxId, schemaZip, expectedZipDigest: SCHEMA_DIGEST })

async function refusal(xml: Buffer, recipientTaxId = BUYER): Promise<InboundRejectionCode> {
  try {
    await verify(xml, recipientTaxId)
  } catch (error) {
    return (error as { code: InboundRejectionCode }).code
  }
  throw new Error('Expected the inbound NF-e to be refused')
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'horizon-phase44-inbound-'))
  supplier = await supplierCredential(directory, SUPPLIER)
  stranger = await supplierCredential(directory, '11222333000181')
  schemaZip = await readFile(SCHEMA_PATH)
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('inbound NF-e verification', () => {
  it('stages the signed supplier invoice, lines, taxes and totals', async () => {
    const signed = signedSupplierInvoice(invoice(), supplier)
    const { invoice: staged, verification } = await verify(signed)
    expect(staged.accessKey).toMatch(/^35\d{4}12345678000195550010000001011\d{9}$/)
    expect(staged.issuer).toMatchObject({ taxId: SUPPLIER, kind: 'cnpj', uf: 'SP' })
    expect(staged.recipient.taxId).toBe(BUYER)
    expect(staged.environment).toBe('homologation')
    expect(staged.lines).toHaveLength(2)
    expect(staged.lines[0]).toMatchObject({
      number: 1,
      productCode: 'GR-01',
      ncm: '09011110',
      quantity: '6',
      unitPrice: '10.00',
      gross: '60.00',
      gtin: null,
    })
    expect(staged.lines[0]?.taxes.map((tax) => tax.group)).toEqual(['IBS', 'CBS'])
    expect(staged.totals).toMatchObject({ products: '67.00', invoice: '67.00' })
    expect(verification).toMatchObject({
      signature: 'valid-unanchored',
      signerTaxId: SUPPLIER,
      protocol: { status: 'absent' },
      authorityStatus: 'unverified',
    })
    expect(verification.contentDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts a matching authorization protocol and keeps the signed content digest', async () => {
    const signed = signedSupplierInvoice(invoice(), supplier)
    const bare = await verify(signed)
    const processed = await verify(withProtocol(signed))
    expect(processed.verification.protocol).toMatchObject({ status: 'authorized', code: '100' })
    expect(processed.verification.contentDigest).toBe(bare.verification.contentDigest)
    expect(processed.verification.sourceDigest).not.toBe(bare.verification.sourceDigest)
  })

  it('refuses protocols that do not authorize this exact signed content', async () => {
    const signed = signedSupplierInvoice(invoice(), supplier)
    expect(await refusal(withProtocol(signed, { code: '110' }))).toBe('PROTOCOL_INVALID')
    expect(await refusal(withProtocol(signed, { digestValue: 'AAAA' }))).toBe('PROTOCOL_INVALID')
    const other = signedSupplierInvoice(invoice({ number: 102 }), supplier)
    const otherKey = /Id="NFe(\w{44})"/.exec(other.toString())?.[1]
    expect(await refusal(withProtocol(signed, { accessKey: otherKey ?? '' }))).toBe(
      'PROTOCOL_INVALID',
    )
  })

  it('refuses declarations, malformed bytes, oversize and invalid UTF-8', async () => {
    const signed = signedSupplierInvoice(invoice(), supplier).toString()
    const doctype = signed.replace('?>', '?><!DOCTYPE NFe [<!ENTITY x "y">]>')
    expect(await refusal(Buffer.from(doctype))).toBe('XML_FORBIDDEN_DECLARATION')
    expect(await refusal(Buffer.from(signed.replace('?>', '?><?evil x?>')))).toBe(
      'XML_FORBIDDEN_DECLARATION',
    )
    expect(await refusal(Buffer.from([0xff, 0xfe, 0x3c]))).toBe('XML_FORBIDDEN_DECLARATION')
    expect(await refusal(Buffer.from(signed.slice(0, -10)))).toBe('XML_MALFORMED')
    expect(await refusal(Buffer.alloc(1024 * 1024 + 1, 0x20))).toBe('XML_TOO_LARGE')
  })

  it('refuses another recipient, an unsigned or tampered NF-e and a foreign signer', async () => {
    const signed = signedSupplierInvoice(invoice(), supplier)
    expect(await refusal(signed, '11222333000181')).toBe('RECIPIENT_MISMATCH')
    expect(await refusal(supplierInvoice(invoice()))).toBe('SCHEMA_INVALID')
    const tampered = Buffer.from(signed.toString().replace('<qCom>6</qCom>', '<qCom>9</qCom>'))
    expect(await refusal(tampered)).toBe('SIGNATURE_INVALID')
    expect(await refusal(signNfe55(supplierInvoice(invoice()), stranger))).toBe('SIGNER_MISMATCH')
  })

  it('refuses wrong model, purpose and access keys that disagree with the content', async () => {
    const unsigned = supplierInvoice(invoice()).toString()
    const resign = (xml: string) => signNfe55(Buffer.from(xml), supplier)
    expect(
      await refusal(resign(unsigned.replace('<finNFe>1</finNFe>', '<finNFe>4</finNFe>'))),
    ).toBe('UNSUPPORTED_DOCUMENT')
    expect(await refusal(resign(unsigned.replace('<tpNF>1</tpNF>', '<tpNF>0</tpNF>')))).toBe(
      'UNSUPPORTED_DOCUMENT',
    )
    expect(await refusal(resign(unsigned.replace('<nNF>101</nNF>', '<nNF>102</nNF>')))).toBe(
      'ACCESS_KEY_INVALID',
    )
    const key = /Id="NFe(\w{44})"/.exec(unsigned)?.[1] ?? ''
    const badDigit = `${key.slice(0, 43)}${(Number(key.at(-1)) + 1) % 10}`
    expect(await refusal(resign(unsigned.replace(`NFe${key}`, `NFe${badDigit}`)))).toBe(
      'ACCESS_KEY_INVALID',
    )
  })

  it('refuses content wrapped around the signed NF-e in nfeProc', async () => {
    const signed = signedSupplierInvoice(invoice(), supplier).toString()
    const wrapped = withProtocol(Buffer.from(signed))
      .toString()
      .replace(
        '</nfeProc>',
        '<infNFe xmlns="http://www.portalfiscal.inf.br/nfe"><qCom>999</qCom></infNFe></nfeProc>',
      )
    expect(await refusal(Buffer.from(wrapped))).toBe('UNSUPPORTED_DOCUMENT')
  })
})
