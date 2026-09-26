import type { FiscalCalculations } from './calculations'
import { decimal4, magnitude, minorToDecimal, minorToFixed, percent } from './nfe-values'
import type { Nfe55Data } from './nfe55/model'
import type { FiscalOriginSnapshot } from './origin-snapshot'

type Calculation = NonNullable<Awaited<ReturnType<FiscalCalculations['readFrozen']>>>
type LineFacts = Record<
  string,
  {
    productCode: string
    cfop: string
    unit: string
    ibsCbsCst: string
    ibsCbsClassification: string
  }
>

/**
 * The `det` facts of an NF-e or NFC-e: frozen origin lines with their reviewed item facts
 * and the IBS/CBS components the locked calculation produced. Both models share this group.
 */
export function nfeLines(input: {
  origin: FiscalOriginSnapshot
  calculation: Calculation
  lineFacts: LineFacts
  cfop?: string | undefined
}): Nfe55Data['lines'] {
  const calculated = new Map(input.calculation.result.lines.map((line) => [line.lineId, line]))
  return input.origin.lines.map((originLine, index) => {
    const facts = input.lineFacts[originLine.itemId]
    const line = calculated.get(originLine.lineId)
    if (!facts || !line) throw new Error('NF-e line facts are incomplete')
    const components = new Map(
      line.components.ibsCbs.map((component) => [component.code, component]),
    )
    const cbs = components.get('CBS')
    const ibsUf = components.get('IBS_UF')
    const ibsMunicipal = components.get('IBS_MUN')
    if (!cbs || !ibsUf || !ibsMunicipal)
      throw new Error('NF-e IBS/CBS calculation components are incomplete')
    if (cbs.base.amount !== ibsUf.base.amount || cbs.base.amount !== ibsMunicipal.base.amount)
      throw new Error('NF-e IBS/CBS bases do not reconcile')
    return {
      number: index + 1,
      productCode: facts.productCode,
      description: originLine.description,
      ncm: input.calculation.input.lines.find((candidate) => candidate.id === originLine.lineId)
        ?.classifications.ncm as string,
      cfop: input.cfop ?? facts.cfop,
      unit: facts.unit,
      quantity: decimal4(originLine.quantity),
      unitPrice: minorToDecimal(originLine.unitPrice.amount),
      gross: minorToFixed(magnitude(line.gross.amount)),
      discount: '0.00',
      other: '0.00',
      ibsCbs: {
        cst: facts.ibsCbsCst,
        classification: facts.ibsCbsClassification,
        base: minorToFixed(magnitude(cbs.base.amount)),
        ibsUfRate: percent(ibsUf.rate),
        ibsUfValue: minorToFixed(magnitude(ibsUf.amount.amount)),
        ibsMunicipalRate: percent(ibsMunicipal.rate),
        ibsMunicipalValue: minorToFixed(magnitude(ibsMunicipal.amount.amount)),
        cbsRate: percent(cbs.rate),
        cbsValue: minorToFixed(magnitude(cbs.amount.amount)),
      },
    }
  })
}

/** The `total` facts, summed from the lines and the locked calculation. */
export function nfeTotals(
  lines: Nfe55Data['lines'],
  calculation: Calculation,
): Nfe55Data['totals'] {
  const sum = (members: string[]) => members.reduce((total, value) => total + BigInt(value), 0n)
  const ibsUf = sum(lines.map((line) => line.ibsCbs.ibsUfValue.replace('.', '')))
  const ibsMunicipal = sum(lines.map((line) => line.ibsCbs.ibsMunicipalValue.replace('.', '')))
  const cbs = sum(lines.map((line) => line.ibsCbs.cbsValue.replace('.', '')))
  const invoice = BigInt(magnitude(calculation.result.totals.net.amount))
  return {
    products: minorToFixed(magnitude(calculation.result.totals.gross.amount)),
    discounts: minorToFixed(calculation.result.totals.discounts.amount),
    other: minorToFixed(calculation.result.totals.charges.amount),
    invoice: minorToFixed(invoice.toString()),
    ibsUf: minorToFixed(ibsUf.toString()),
    ibsMunicipal: minorToFixed(ibsMunicipal.toString()),
    ibs: minorToFixed((ibsUf + ibsMunicipal).toString()),
    cbs: minorToFixed(cbs.toString()),
    ibsCbsBase: minorToFixed(
      sum(lines.map((line) => line.ibsCbs.base.replace('.', ''))).toString(),
    ),
    invoiceWithIbsCbs: minorToFixed((invoice + ibsUf + ibsMunicipal + cbs).toString()),
  }
}
