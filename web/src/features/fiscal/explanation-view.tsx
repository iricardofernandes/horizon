'use client'

import { useTranslations } from 'next-intl'
import { useMoney } from '@/lib/use-format'
import { percentOf } from './rules/types'

type Money = { amount: string; currency: string }
type Fraction = { numerator: string; denominator: string }

/** The calculation a document locked, as `GET /documents/:id/calculation` returns it. */
export type LockedCalculation = {
  lines: {
    lineId: string
    components: Record<'legacy' | 'ibsCbs', LockedComponent[]>
  }[]
}

type LockedComponent = {
  code: string
  base: Money
  rate: Fraction
  amount: Money
  formula: string
  outcome?: string
  steps?: { step: string; value: Fraction }[]
  rule: { id: string; version: number }
  source: { uri: string; section: string; digest: string }
}

/**
 * Why each component costs what it costs (Phase 88): the base, the rate, the steps an
 * expression took, the outcome, and the rule and source it came from.
 */
export function ComponentExplanation({ calculation }: { calculation: LockedCalculation }) {
  const t = useTranslations('fiscal.explain')
  const money = useMoney()
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t('line')}</th>
            <th>{t('component')}</th>
            <th className="numeric">{t('base')}</th>
            <th>{t('rate')}</th>
            <th className="numeric">{t('amount')}</th>
            <th>{t('rule')}</th>
          </tr>
        </thead>
        <tbody>
          {calculation.lines.flatMap((line, index) =>
            [...line.components.legacy, ...line.components.ibsCbs].map((component) => (
              <tr key={`${line.lineId}:${component.code}`}>
                <td>{index + 1}</td>
                <td>
                  {component.code}
                  {component.outcome && component.outcome !== 'levied' ? (
                    <small> · {t(`outcomes.${component.outcome}`)}</small>
                  ) : null}
                  {component.steps?.length ? (
                    <details>
                      <summary>{t('steps', { count: component.steps.length })}</summary>
                      <ol className="explanation-steps">
                        {component.steps.map((step) => (
                          <li
                            key={`${step.step}:${step.value.numerator}/${step.value.denominator}`}
                          >
                            {step.step}: {fractionText(step.value)}
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                </td>
                <td className="numeric">{money(component.base.amount, component.base.currency)}</td>
                <td>{percentOf(component.rate)}</td>
                <td className="numeric">
                  {money(component.amount.amount, component.amount.currency)}
                </td>
                <td>
                  <code className="table-code">{component.rule.id.slice(0, 8)}</code> v
                  {component.rule.version}
                  <br />
                  <small>
                    {component.source.section} ·{' '}
                    <code className="table-code">{component.source.digest.slice(0, 12)}…</code>
                  </small>
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  )
}

/** A step's exact value, as a decimal when it is one and as a fraction otherwise. */
function fractionText(value: Fraction): string {
  const numerator = BigInt(value.numerator)
  const denominator = BigInt(value.denominator)
  if (numerator % denominator === 0n) return (numerator / denominator).toString()
  return `${value.numerator}/${value.denominator}`
}
