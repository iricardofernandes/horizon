import {
  type FiscalTaxSupportMatrix,
  fiscalTaxSupportMatrixSchema,
  fiscalTaxSupportQuerySchema,
} from '@horizon/contracts'
import generated from '../support-matrix.json'
import { answer } from './tax-support'

/** The matrix this build was generated with (`npm run phase85:scenarios -- matrix`). */
export const SUPPORT_MATRIX: FiscalTaxSupportMatrix = fiscalTaxSupportMatrixSchema.parse(generated)

const CLASSIFICATIONS = [
  ['ncm', 'ncm'],
  ['service', 'service'],
  ['classTrib', 'class_trib'],
] as const

/**
 * `GET /support`: the matrix, or, given a scenario, whether it is supported. A scenario names
 * one classification (`ncm`, `service` or `classTrib`) and the tax it asks about.
 */
export function taxSupportResponse(
  searchParams: URLSearchParams,
  matrix: FiscalTaxSupportMatrix = SUPPORT_MATRIX,
): { status: 200; body: unknown } | { status: 400; detail: string } {
  if ([...searchParams.keys()].length === 0) return { status: 200, body: matrix }
  const named = CLASSIFICATIONS.filter(([parameter]) => searchParams.has(parameter))
  if (named.length !== 1)
    return { status: 400, detail: 'Name exactly one of ncm, service or classTrib' }
  const [parameter, kind] = named[0] ?? CLASSIFICATIONS[0]
  const taxpayer = searchParams.get('recipientTaxpayer')
  const optional = (name: string) => searchParams.get(name) ?? undefined
  const parsed = fiscalTaxSupportQuerySchema.safeParse({
    model: searchParams.get('model'),
    date: searchParams.get('date'),
    tax: searchParams.get('tax'),
    classification: { kind, code: searchParams.get(parameter) },
    originState: optional('originState'),
    destinationState: optional('destinationState'),
    recipientTaxpayer:
      taxpayer === null
        ? undefined
        : taxpayer === 'true'
          ? true
          : taxpayer === 'false'
            ? false
            : taxpayer,
    issuerRegime: optional('issuerRegime'),
    incomeTaxRegime: optional('incomeTaxRegime'),
    issuerMunicipality: optional('issuerMunicipality'),
    origin: optional('origin'),
    facts: Object.fromEntries(
      [...searchParams.entries()]
        .filter(([name]) => name.startsWith('fact.'))
        .map(([name, value]) => [name.slice('fact.'.length), value]),
    ),
  })
  if (!parsed.success) return { status: 400, detail: 'Invalid tax support query' }
  return { status: 200, body: answer(matrix, parsed.data) }
}
