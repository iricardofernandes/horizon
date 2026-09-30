import type { FiscalCalculationInput } from '@horizon/contracts'
import type { IssuerFiscalExport } from './projections'

/**
 * The issuer's regime as the calculation reads it (Phase 86): the NF-e's CRT (`normal`,
 * `simples-nacional`, `mei`) and, for a normal issuer, its income-tax regime, which decides
 * the PIS/Cofins method. Taken from the profile revision in force on the issue date, so a
 * change applies from its own date and never to a calculation already locked.
 */
export function issuerRegimeOf(
  fiscalRegime: IssuerFiscalExport['company']['fiscalRegime'],
): Pick<FiscalCalculationInput['issuer'], 'regime' | 'incomeTaxRegime'> | null {
  switch (fiscalRegime) {
    case 'lucro-real':
    case 'lucro-presumido':
      return { regime: 'normal', incomeTaxRegime: fiscalRegime }
    case 'simples-nacional':
      return { regime: 'simples-nacional' }
    case 'mei':
      return { regime: 'mei' }
    default:
      return null
  }
}
