import { buildNfe55AccessKey } from '../nfe55/access-key'
import type { Nfce65DataInput } from './model'
import { onlineQrCodeV3, SIMULATION_KEY_QUERY_URL, SIMULATION_QR_URL } from './qr-code'

/** A frozen NFC-e used by the model 65 specs. */
export function accessKey(input: {
  model?: '55' | '65'
  number?: number
  emissionType?: number
}): string {
  return buildNfe55AccessKey({
    issuerUfCode: '35',
    issuedOn: '2026-09-26',
    issuerTaxId: '00000000E08G12',
    model: input.model ?? '65',
    series: 1,
    number: input.number ?? 1,
    emissionType: input.emissionType ?? 1,
    numericCode: '12345678',
  })
}

export function nfceFixture(): Nfce65DataInput {
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
  const key = accessKey({})
  return {
    accessKey: key,
    issuedAt: '2026-09-26T10:15:00-03:00',
    natureOperation: 'Venda a consumidor final',
    numericCode: '12345678',
    processVersion: 'horizon-phase46',
    series: 1,
    number: 1,
    environment: '2',
    presence: '4',
    issuer: {
      taxId: '00000000E08G12',
      legalName: 'Horizon Café Simulação LTDA',
      stateRegistration: '123456789',
      address,
    },
    consumer: {
      kind: 'cpf',
      taxId: '12345678909',
      name: 'Consumidora Simulada',
      address: { ...address, street: 'Rua das Flores', number: '7' },
    },
    lines: [
      {
        number: 1,
        productCode: 'CAFE-001',
        description: 'Café torrado em grãos',
        ncm: '09012100',
        cfop: '5102',
        unit: 'UN',
        quantity: '2.0000',
        unitPrice: '50.00',
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
    payment: { indicator: '1', method: '05', amount: '100.00' },
    supplement: {
      qrCode: onlineQrCodeV3({ queryUrl: SIMULATION_QR_URL, accessKey: key, environment: '2' }),
      keyQueryUrl: SIMULATION_KEY_QUERY_URL,
    },
  }
}
