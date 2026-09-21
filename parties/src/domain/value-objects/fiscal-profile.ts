import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

export const TAXPAYER_INDICATORS = ['contributor', 'exempt', 'non-contributor'] as const
export type TaxpayerIndicator = (typeof TAXPAYER_INDICATORS)[number]

export interface FiscalAddress {
  readonly street: string
  readonly number: string
  readonly complement: string | null
  readonly district: string
  readonly city: string
  readonly municipalityCode: string | null
  readonly state: string | null
  readonly postalCode: string
  readonly country: string
}

export interface FiscalProfileData {
  readonly effectiveFrom: string
  readonly stateRegistration: string | null
  readonly municipalRegistration: string | null
  readonly taxpayerIndicator: TaxpayerIndicator
  readonly finalConsumer: boolean
  readonly address: FiscalAddress
}

export type FiscalProfileInput = Omit<FiscalProfileData, 'address'> & {
  readonly address: FiscalAddress
}

/** Optional until an operator verifies a recipient's fiscal details. Never inferred from free text. */
export class FiscalProfile extends ValueObject<FiscalProfileData> {
  static create(input: FiscalProfileInput): Either<InvalidInputError, FiscalProfile> {
    const address = input.address
    const country = address.country.trim().toUpperCase()
    const municipalityCode = address.municipalityCode?.trim() || null
    const state = address.state?.trim().toUpperCase() || null
    const invalid =
      validateFields(input) ?? validateAddress(address, country, municipalityCode, state)
    if (invalid) return left(invalid)
    return right(
      new FiscalProfile({
        effectiveFrom: input.effectiveFrom,
        stateRegistration: input.stateRegistration?.trim() ?? null,
        municipalRegistration: input.municipalRegistration?.trim() ?? null,
        taxpayerIndicator: input.taxpayerIndicator,
        finalConsumer: input.finalConsumer,
        address: {
          street: address.street.trim(),
          number: address.number.trim(),
          complement: address.complement?.trim() || null,
          district: address.district.trim(),
          city: address.city.trim(),
          municipalityCode,
          state,
          postalCode: address.postalCode.replace(/\D/g, ''),
          country,
        },
      }),
    )
  }

  get details(): Readonly<FiscalProfileData> {
    return Object.freeze({ ...this.props, address: Object.freeze({ ...this.props.address }) })
  }

  protected componentsOf(): readonly unknown[] {
    return [JSON.stringify(this.props)]
  }
}

function validateFields(input: FiscalProfileInput): InvalidInputError | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom) || !validCalendarDate(input.effectiveFrom))
    return new InvalidInputError('/effectiveFrom', 'must be a calendar date')
  if (!TAXPAYER_INDICATORS.includes(input.taxpayerIndicator))
    return new InvalidInputError('/taxpayerIndicator', 'is not a known indicator')
  if (typeof input.finalConsumer !== 'boolean')
    return new InvalidInputError('/finalConsumer', 'must be a boolean')
  for (const [field, value] of [
    ['stateRegistration', input.stateRegistration],
    ['municipalRegistration', input.municipalRegistration],
  ] as const) {
    if (value !== null && (value.trim().length === 0 || value.length > 40))
      return new InvalidInputError(`/${field}`, 'must contain 1 to 40 characters')
  }
  return null
}

function validateAddress(
  address: FiscalAddress,
  country: string,
  municipalityCode: string | null,
  state: string | null,
): InvalidInputError | null {
  if (!/^[A-Z]{2}$/.test(country))
    return new InvalidInputError('/address/country', 'must be a two-letter country code')
  if (country === 'BR' && !/^\d{7}$/.test(municipalityCode ?? ''))
    return new InvalidInputError('/address/municipalityCode', 'must be a seven-digit IBGE code')
  if (country === 'BR' && !/^[A-Z]{2}$/.test(state ?? ''))
    return new InvalidInputError('/address/state', 'must be a two-letter state code')
  if (country === 'BR' && !/^\d{8}$/.test(address.postalCode.replace(/\D/g, '')))
    return new InvalidInputError('/address/postalCode', 'must be an eight-digit CEP')
  for (const [field, value] of [
    ['street', address.street],
    ['number', address.number],
    ['district', address.district],
    ['city', address.city],
  ] as const) {
    if (value.trim().length === 0 || value.length > 160)
      return new InvalidInputError(`/address/${field}`, 'must contain 1 to 160 characters')
  }
  return null
}

function validCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
