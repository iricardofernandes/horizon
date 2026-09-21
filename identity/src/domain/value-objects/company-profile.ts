import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

/**
 * The regimes a Brazilian company operates under. Stored so Fiscal can later select rules
 * by regime; recording one claims nothing about tax calculation, which does not exist yet.
 */
export const FISCAL_REGIMES = [
  'simples-nacional',
  'lucro-presumido',
  'lucro-real',
  'mei',
  'not-declared',
] as const
export type FiscalRegime = (typeof FISCAL_REGIMES)[number]

export interface CompanyAddress {
  readonly line: string | null
  readonly city: string | null
  readonly municipalityCode: string | null
  readonly state: string | null
  readonly postalCode: string | null
  readonly country: string
}

export interface CompanyProfileProps {
  readonly legalName: string
  readonly tradeName: string | null
  readonly taxId: string | null
  readonly stateRegistration: string | null
  readonly municipalRegistration: string | null
  readonly address: CompanyAddress
  readonly baseCurrency: string
  readonly fiscalRegime: FiscalRegime
}

export interface CompanyProfileInput {
  readonly legalName: string
  readonly tradeName?: string | null | undefined
  readonly taxId?: string | null | undefined
  readonly stateRegistration?: string | null | undefined
  readonly municipalRegistration?: string | null | undefined
  readonly addressLine?: string | null | undefined
  readonly addressCity?: string | null | undefined
  readonly addressMunicipalityCode?: string | null | undefined
  readonly addressState?: string | null | undefined
  readonly addressPostalCode?: string | null | undefined
  readonly addressCountry?: string | null | undefined
  readonly baseCurrency: string
  readonly fiscalRegime: FiscalRegime
}

/**
 * Who the workspace legally is, and the money it reports in.
 *
 * This is deliberately separate from the reader's locale: a Brazilian company read in
 * English still reports in BRL and still files under its own regime (ADR 0044). The tax
 * identifier here is the company's own registration, not a data subject's, so it is not
 * crypto-shredded like personal data is.
 */
export class CompanyProfile extends ValueObject<CompanyProfileProps> {
  static create(input: CompanyProfileInput): Either<InvalidInputError, CompanyProfile> {
    const legalName = input.legalName.trim()
    if (legalName.length < 2)
      return left(new InvalidInputError('/legalName', 'legal name is required'))
    if (legalName.length > 200)
      return left(new InvalidInputError('/legalName', 'legal name is longer than 200 characters'))

    const currency = input.baseCurrency.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(currency))
      return left(new InvalidInputError('/baseCurrency', 'must be a three-letter ISO 4217 code'))

    if (!FISCAL_REGIMES.includes(input.fiscalRegime))
      return left(new InvalidInputError('/fiscalRegime', 'is not a known fiscal regime'))

    const country = (input.addressCountry ?? 'BR').trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(country))
      return left(new InvalidInputError('/addressCountry', 'must be an ISO 3166-1 alpha-2 code'))

    const taxId = canonicalTaxId(input.taxId)
    if (taxId !== null && country === 'BR' && !/^(?:\d{11}|[A-Z0-9]{12}\d{2})$/.test(taxId))
      return left(new InvalidInputError('/taxId', 'must be an 11-digit CPF or 14-character CNPJ'))

    const municipalityCode = optional(input.addressMunicipalityCode)
    if (municipalityCode !== null && !/^\d{7}$/.test(municipalityCode))
      return left(
        new InvalidInputError('/addressMunicipalityCode', 'must be a seven-digit IBGE code'),
      )

    return right(
      new CompanyProfile({
        legalName,
        tradeName: optional(input.tradeName),
        taxId,
        stateRegistration: optional(input.stateRegistration),
        municipalRegistration: optional(input.municipalRegistration),
        address: {
          line: optional(input.addressLine),
          city: optional(input.addressCity),
          municipalityCode,
          state: optional(input.addressState),
          postalCode: optional(input.addressPostalCode),
          country,
        },
        baseCurrency: currency,
        fiscalRegime: input.fiscalRegime,
      }),
    )
  }

  get legalName(): string {
    return this.props.legalName
  }

  get baseCurrency(): string {
    return this.props.baseCurrency
  }

  get fiscalRegime(): FiscalRegime {
    return this.props.fiscalRegime
  }

  /**
   * The frozen struct persistence and presentation read. A getter rather than a
   * `toSnapshot()`, because that name belongs to entities crossing the boundary and this
   * value object is read from inside one (ADR 0031).
   */
  get details(): Readonly<CompanyProfileProps> {
    return Object.freeze({ ...this.props, address: Object.freeze({ ...this.props.address }) })
  }

  protected componentsOf(): readonly unknown[] {
    return [
      this.props.legalName,
      this.props.tradeName,
      this.props.taxId,
      this.props.stateRegistration,
      this.props.municipalRegistration,
      this.props.address.line,
      this.props.address.city,
      this.props.address.municipalityCode,
      this.props.address.state,
      this.props.address.postalCode,
      this.props.address.country,
      this.props.baseCurrency,
      this.props.fiscalRegime,
    ]
  }
}

function optional(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length === 0 ? null : trimmed
}

/** Preserve letters in new CNPJs while keeping numeric registrations canonical. */
function canonicalTaxId(value: string | null | undefined): string | null {
  const canonical =
    value
      ?.trim()
      .toUpperCase()
      .replace(/[.\-/\s]/g, '') ?? ''
  return canonical.length === 0 ? null : canonical
}
