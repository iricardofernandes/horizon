import type { FiscalCalculations } from '../calculations'
import type { FiscalDocuments } from '../documents'
import { nfeLines, nfeTotals } from '../nfe-lines'
import { deterministicNumericCode, digits } from '../nfe-values'
import { buildNfe55AccessKey } from '../nfe55/access-key'
import type { Nfe55IssuanceProfile } from '../nfe55/issuance-profile'
import type { FiscalOriginSnapshot } from '../origin-snapshot'
import type { FiscalProjections } from '../projections'
import type { Nfce65Data } from './model'
import { onlineQrCodeV3, SIMULATION_KEY_QUERY_URL, SIMULATION_QR_URL } from './qr-code'

/**
 * Maps frozen Sales, projection and calculation facts to one NFC-e. `issuedAt` is the
 * instant the document is signed, in the issuer's timezone (NT 2025.001 §02.4).
 */
export function buildNfce65Data(input: {
  document: NonNullable<Awaited<ReturnType<FiscalDocuments['get']>>>
  number: number
  issuer: NonNullable<Awaited<ReturnType<FiscalProjections['readIssuer']>>>
  recipient: NonNullable<Awaited<ReturnType<FiscalProjections['readParty']>>>
  calculation: NonNullable<Awaited<ReturnType<FiscalCalculations['readFrozen']>>>
  origin: FiscalOriginSnapshot
  profile: Nfe55IssuanceProfile
  capabilityId: string
  issuedAt: string
}): Nfce65Data {
  const consumerProfile = input.profile.consumer
  if (!consumerProfile || consumerProfile.capabilityId !== input.capabilityId)
    throw new Error('NFC-e issuance profile is incomplete for this capability')
  if (input.origin.originModule !== 'sales' || input.origin.purpose !== 'original')
    throw new Error('An NFC-e is issued only for a Sales consumer sale')
  if (input.issuedAt.slice(0, 10) !== input.calculation.input.issueDate) throw new ReadinessStale()
  const issuerAddress = input.issuer.company.address
  if (
    !input.issuer.company.taxId ||
    !input.issuer.company.stateRegistration ||
    !issuerAddress.city ||
    !issuerAddress.municipalityCode ||
    !issuerAddress.state ||
    !issuerAddress.postalCode
  )
    throw new Error('NFC-e issuer facts are incomplete')
  const numericCode = deterministicNumericCode(input.document.id)
  const accessKey = buildNfe55AccessKey({
    issuerUfCode: input.calculation.input.issuer.stateCode,
    issuedOn: input.issuedAt.slice(0, 10),
    issuerTaxId: input.issuer.company.taxId,
    model: '65',
    series: input.document.series,
    number: input.number,
    numericCode,
  })
  const lines = nfeLines({
    origin: input.origin,
    calculation: input.calculation,
    lineFacts: input.profile.lineFacts,
  })
  const totals = nfeTotals(lines, input.calculation)
  return {
    accessKey,
    issuedAt: input.issuedAt,
    natureOperation: consumerProfile.natureOperation,
    numericCode,
    processVersion: 'horizon-phase46',
    series: input.document.series,
    number: input.number,
    environment: '2',
    presence: consumerProfile.presence,
    issuer: {
      taxId: input.issuer.company.taxId,
      legalName: input.issuer.company.legalName.slice(0, 60),
      stateRegistration: input.issuer.company.stateRegistration,
      address: {
        ...input.profile.issuerAddress,
        municipalityCode: issuerAddress.municipalityCode,
        city: issuerAddress.city,
        state: issuerAddress.state,
        postalCode: digits(issuerAddress.postalCode, 8),
      },
    },
    consumer: consumer(input.recipient),
    lines,
    totals,
    payment: {
      indicator: consumerProfile.payment.indicator,
      method: consumerProfile.payment.method,
      amount: totals.invoice,
    },
    supplement: {
      qrCode: onlineQrCodeV3({ queryUrl: SIMULATION_QR_URL, accessKey, environment: '2' }),
      keyQueryUrl: SIMULATION_KEY_QUERY_URL,
    },
  }
}

/** The calendar day of `dhEmi` no longer matches the locked calculation. */
export class ReadinessStale extends Error {
  readonly code = 'READINESS_STALE'
  constructor() {
    super('Fiscal readiness is stale: validate the document again before issuing it')
  }
}

function consumer(
  recipient: NonNullable<Awaited<ReturnType<FiscalProjections['readParty']>>>,
): Nfce65Data['consumer'] {
  const taxId = recipient.taxId.toUpperCase().replace(/[.\-/\s]/g, '')
  const address = recipient.profile.address
  const delivery =
    address.municipalityCode && address.state && address.postalCode
      ? {
          street: address.street.slice(0, 60),
          number: address.number.slice(0, 60),
          complement: address.complement ? address.complement.slice(0, 60) : null,
          district: address.district.slice(0, 60),
          municipalityCode: address.municipalityCode,
          city: address.city.slice(0, 60),
          state: address.state,
          postalCode: digits(address.postalCode, 8),
        }
      : null
  const name = recipient.legalName.slice(0, 60)
  if (recipient.kind === 'person' && /^\d{11}$/.test(taxId))
    return { kind: 'cpf', taxId, name, address: delivery }
  if (recipient.kind === 'organization' && /^[0-9A-Z]{12}[0-9]{2}$/.test(taxId))
    return { kind: 'cnpj', taxId, name, address: delivery }
  throw new Error('NFC-e consumer identification does not match the party kind')
}
