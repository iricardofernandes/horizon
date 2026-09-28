'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { amountColumn, type FigureTable, type SourceState } from '@/lib/reports'
import { useStatusLabel } from '@/lib/status'
import { useDateTime, useMoney } from '@/lib/use-format'

/** A report's figures, as Reporting sent them: column names stay the API's own (ADR 0044). */
export function FigureTables({ tables }: { tables: readonly FigureTable[] }) {
  const t = useTranslations('reports')
  const money = useMoney()
  const cell = (row: Record<string, string>, column: string) => {
    const value = row[column] ?? ''
    return row.currency && value && amountColumn(column) ? money(value, row.currency) : value
  }
  if (!tables.length) return <p className="catalog-page-copy">{t('noFigures')}</p>
  return (
    <>
      {tables.map((table) => (
        <div className="table-scroll" key={table.key || 'summary'}>
          {table.key ? <h3 className="report-table-title">{table.key}</h3> : null}
          <table>
            <thead>
              <tr>
                {table.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, index) => (
                // Figures have no id of their own; their order is the report's.
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are never reordered.
                <tr key={index}>
                  {table.columns.map((column) => (
                    <td className={amountColumn(column) ? 'numeric' : undefined} key={column}>
                      {cell(row, column)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  )
}

/** Where each source stands: settled through the cutoff, or still arriving. */
export function SourceStates({ sources }: { sources: readonly SourceState[] }) {
  const t = useTranslations('reports')
  const modules = useTranslations('modules')
  const statusLabel = useStatusLabel()
  const dateTime = useDateTime()
  return (
    <ul className="report-sources">
      {sources.map((source) => (
        <li key={source.source}>
          <strong>{modules(source.source)}</strong>
          <Badge
            label={source.settled ? t('settled') : statusLabel('pending')}
            status={source.settled ? 'settled' : 'pending'}
          />
          <small>
            {source.watermark
              ? t('completeThrough', { when: dateTime(source.watermark) })
              : t('neverSealed')}
          </small>
        </li>
      ))}
    </ul>
  )
}
