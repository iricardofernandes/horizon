'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Empty } from '@/components/ui/state'
import { useDate, useMoney } from '@/lib/use-format'
import { percentOf, type RuleDiff, type RuleImpact, type RuleSummary } from './types'

const CHANGE_TONE = {
  added: 'approved',
  ended: 'rejected',
  changed: 'pending',
  unchanged: 'draft',
} as const

/** What a change does to each rule key, with the fields that differ (Phase 88). */
export function DiffView({
  diff,
  showUnchanged = false,
}: {
  diff: RuleDiff
  showUnchanged?: boolean
}) {
  const t = useTranslations('fiscal.rules')
  const entries = diff.entries.filter((entry) => showUnchanged || entry.change !== 'unchanged')
  return (
    <section aria-label={t('diffTitle')}>
      <p className="document-note">{t('diffCounts', diff.counts)}</p>
      {entries.length === 0 ? (
        <Empty copy={t('diffEmpty')} />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('ruleKey')}</th>
                <th>{t('change')}</th>
                <th>{t('before')}</th>
                <th>{t('after')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.ruleKey}>
                  <td>
                    <code className="table-code">{entry.ruleKey}</code>
                  </td>
                  <td>
                    <Badge
                      label={t(`changes.${entry.change}`)}
                      status={CHANGE_TONE[entry.change]}
                    />
                  </td>
                  <td>
                    {entry.change === 'changed' || entry.change === 'ended' ? (
                      <RuleFacts fields={fieldsOf(entry, 'before')} rule={entry.before} />
                    ) : null}
                  </td>
                  <td>
                    {entry.change === 'changed' || entry.change === 'added' ? (
                      <RuleFacts fields={fieldsOf(entry, 'after')} rule={entry.after} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function fieldsOf(entry: RuleDiff['entries'][number], side: 'before' | 'after') {
  return entry.fields.map((field) => ({ field: field.field, value: field[side] }))
}

/** A rule in brief; when fields differ, those fields alone. */
function RuleFacts({
  rule,
  fields,
}: {
  rule: RuleSummary | null
  fields: { field: string; value: unknown }[]
}) {
  const t = useTranslations('fiscal.rules')
  if (!rule) return null
  if (fields.length)
    return (
      <dl className="rule-fields">
        {fields.map((field) => (
          <div className="rule-field" key={field.field}>
            <dt>{t(`fields.${field.field}`)}</dt>
            <dd>{describe(field.field, field.value)}</dd>
          </div>
        ))}
      </dl>
    )
  return (
    <span>
      {rule.code} {percentOf(rule.rate)} · {rule.precedence}/{rule.priority} · {rule.effectiveFrom}
      {rule.effectiveTo ? ` → ${rule.effectiveTo}` : ''}
    </span>
  )
}

function describe(field: string, value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (field === 'rate') return percentOf(value as RuleSummary['rate'])
  if (field === 'scope')
    return Object.entries(value as Record<string, string>)
      .map(([key, entry]) => `${key}=${entry}`)
      .join(', ')
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** The locked documents a change would alter, and those it would leave without a calculation. */
export function ImpactView({ impact }: { impact: RuleImpact }) {
  const t = useTranslations('fiscal.rules')
  const money = useMoney()
  const date = useDate()
  return (
    <section aria-label={t('impactTitle')}>
      <p className="document-note">
        {t('impactSummary', {
          months: impact.months,
          from: date(impact.from),
          to: date(impact.to),
          examined: impact.examined,
          changed: impact.changed.length,
          unsupported: impact.unsupported.length,
          unchanged: impact.unchanged,
        })}
      </p>
      {impact.truncated ? <p className="document-note">{t('impactTruncated')}</p> : null}
      {impact.changed.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('document')}</th>
                <th>{t('issueDate')}</th>
                <th>{t('component')}</th>
                <th className="numeric">{t('before')}</th>
                <th className="numeric">{t('after')}</th>
                <th className="numeric">{t('difference')}</th>
              </tr>
            </thead>
            <tbody>
              {impact.changed.flatMap((document) =>
                document.components.map((component) => (
                  <tr key={`${document.documentId}:${component.code}`}>
                    <td>
                      <code className="table-code">{document.documentId.slice(0, 8)}</code>
                    </td>
                    <td>{date(document.issueDate)}</td>
                    <td>{component.code}</td>
                    <td className="numeric">{money(component.before, 'BRL')}</td>
                    <td className="numeric">{money(component.after, 'BRL')}</td>
                    <td className="numeric">{money(component.difference, 'BRL')}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      {impact.unsupported.length ? (
        <>
          <h4>{t('impactUnsupported')}</h4>
          <ul className="rule-impact-unsupported">
            {impact.unsupported.map((entry) => (
              <li key={entry.documentId}>
                <code className="table-code">{entry.documentId.slice(0, 8)}</code>{' '}
                {date(entry.issueDate)} · {entry.code} — {entry.detail}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="document-note">{t('impactDigest', { digest: impact.digest.slice(0, 12) })}</p>
    </section>
  )
}
