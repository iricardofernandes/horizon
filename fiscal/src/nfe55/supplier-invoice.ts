import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildNfe55AccessKey } from './access-key'
import type { Nfe55Data } from './model'
import { type SimulationCredential, signNfe55 } from './signature'
import { serializeNfe55 } from './xml'

/**
 * Supplier NF-e fixtures for simulation and tests only: a homologation-environment
 * outbound invoice from a supplier to the tenant, with reconciling amounts. It is never
 * used to issue a document of the tenant's own.
 */
export type SupplierLine = {
  productCode: string
  description: string
  ncm: string
  unit?: string
  quantity: string
  unitPrice: string
}

/** Serializes an outbound supplier NF-e addressed to the recipient; amounts reconcile. */
export function supplierInvoice(input: {
  supplierTaxId: string
  recipientTaxId: string
  number: number
  series?: number
  numericCode?: string
  issuedAt?: string
  lines: SupplierLine[]
}): Buffer {
  const issuedAt = input.issuedAt ?? brazilNow()
  const series = input.series ?? 1
  const numericCode = input.numericCode ?? String(10_000_000 + input.number).slice(-8)
  const accessKey = buildNfe55AccessKey({
    issuerUfCode: '35',
    issuedOn: issuedAt.slice(0, 10),
    issuerTaxId: input.supplierTaxId,
    model: '55',
    series,
    number: input.number,
    numericCode,
  })
  const address = {
    street: 'Rua do Fornecedor',
    number: '10',
    complement: null,
    district: 'Centro',
    municipalityCode: '3550308',
    city: 'São Paulo',
    state: 'SP',
    postalCode: '01001000',
  } as const
  const lines = input.lines.map((line, index) => {
    const gross = money(minor(line.unitPrice) * units(line.quantity))
    const grossMinor = minor(gross)
    return {
      number: index + 1,
      productCode: line.productCode,
      description: line.description,
      ncm: line.ncm,
      cfop: '5102',
      unit: line.unit ?? 'UN',
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      gross,
      discount: '0.00',
      other: '0.00',
      ibsCbs: {
        cst: '000',
        classification: '000001',
        base: gross,
        ibsUfRate: '0.1000',
        ibsUfValue: money((grossMinor + 500n) / 1000n),
        ibsMunicipalRate: '0.0000',
        ibsMunicipalValue: '0.00',
        cbsRate: '0.9000',
        cbsValue: money((grossMinor * 9n + 500n) / 1000n),
      },
    }
  })
  const sum = (pick: (line: (typeof lines)[number]) => string) =>
    lines.reduce((total, line) => total + minor(pick(line)), 0n)
  const products = sum((line) => line.gross)
  const ibs = sum((line) => line.ibsCbs.ibsUfValue)
  const cbs = sum((line) => line.ibsCbs.cbsValue)
  const data: Nfe55Data = {
    accessKey,
    issuedAt,
    natureOperation: 'Venda de mercadoria',
    numericCode,
    series,
    number: input.number,
    issuer: {
      taxId: input.supplierTaxId,
      legalName: 'Fornecedor de Teste LTDA',
      stateRegistration: '111222333',
      address,
    },
    recipient: {
      taxId: input.recipientTaxId,
      legalName: 'Comprador de Teste LTDA',
      stateRegistration: '444555666',
      address: { ...address, street: 'Avenida do Comprador' },
    },
    lines,
    totals: {
      products: money(products),
      discounts: '0.00',
      other: '0.00',
      invoice: money(products),
      ibsUf: money(ibs),
      ibsMunicipal: '0.00',
      ibs: money(ibs),
      cbs: money(cbs),
      ibsCbsBase: money(products),
      invoiceWithIbsCbs: money(products + ibs + cbs),
    },
  }
  return serializeNfe55(data)
}

export function signedSupplierInvoice(
  input: Parameters<typeof supplierInvoice>[0],
  credential: SimulationCredential,
): Buffer {
  return signNfe55(supplierInvoice(input), credential)
}

/** Wraps a signed NF-e in `nfeProc` with an authorization protocol that matches it. */
export function withProtocol(
  signed: Buffer,
  overrides: { code?: string; digestValue?: string; accessKey?: string } = {},
): Buffer {
  const xml = signed.toString('utf8').replace(/^<\?xml[^>]*\?>/, '')
  const accessKey = overrides.accessKey ?? /Id="NFe(\w{44})"/.exec(xml)?.[1] ?? ''
  const digestValue = overrides.digestValue ?? /<DigestValue>([^<]+)</.exec(xml)?.[1] ?? ''
  return Buffer.from(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">',
      xml,
      '<protNFe versao="4.00"><infProt>',
      '<tpAmb>2</tpAmb><verAplic>TEST</verAplic>',
      `<chNFe>${accessKey}</chNFe>`,
      `<dhRecbto>${brazilNow()}</dhRecbto>`,
      '<nProt>135260000000001</nProt>',
      `<digVal>${digestValue}</digVal>`,
      `<cStat>${overrides.code ?? '100'}</cStat>`,
      '<xMotivo>Autorizado o uso da NF-e</xMotivo>',
      '</infProt></protNFe>',
      '</nfeProc>',
    ].join(''),
    'utf8',
  )
}

export function brazilNow(offsetMs = 0): string {
  return `${new Date(Date.now() + offsetMs - 3 * 3_600_000).toISOString().slice(0, 19)}-03:00`
}

function minor(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
}

/** Whole units only: fixtures keep quantities integral so gross is exact. */
function units(quantity: string): bigint {
  const [whole = '0', fraction = ''] = quantity.split('.')
  if (/[1-9]/.test(fraction)) throw new Error('Fixture quantities must be whole units')
  return BigInt(whole)
}

function money(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`
}

/** A self-signed test A1 carrying the ICP-Brasil CNPJ otherName, valid since yesterday. */
export async function supplierCredential(
  directory: string,
  taxId: string,
): Promise<SimulationCredential> {
  const keyPath = join(directory, `${taxId}.key.pem`)
  const certificatePath = join(directory, `${taxId}.cert.pem`)
  const stamp = (offsetDays: number) =>
    `${new Date(Date.now() + offsetDays * 86_400_000).toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-not_before',
    stamp(-1),
    '-not_after',
    stamp(2),
    '-subj',
    '/CN=Horizon Supplier Test Only',
    '-addext',
    `subjectAltName=otherName:2.16.76.1.3.3;PRINTABLE:${taxId}`,
    '-keyout',
    keyPath,
    '-out',
    certificatePath,
  ])
  return { privateKey: await readFile(keyPath), certificate: await readFile(certificatePath) }
}
