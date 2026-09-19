'use client'

import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'

/**
 * Work in the columns it moves through.
 *
 * A board is for what still needs doing, so a column that is empty says so rather than
 * disappearing: a buyer reading "nothing waiting for approval" has learned something, and a
 * board whose columns move about between visits cannot be read at a glance.
 */
export function PurchasingBoard<T>({
  columns,
  rows,
  columnOf,
  renderCard,
  keyOf,
}: {
  columns: readonly string[]
  rows: readonly T[]
  columnOf: (row: T) => string
  renderCard: (row: T) => ReactNode
  keyOf: (row: T) => string
}) {
  const t = useTranslations('purchasing')
  return (
    <div className="board">
      {columns.map((column) => {
        const cards = rows.filter((row) => columnOf(row) === column)
        return (
          <section aria-label={t(`column.${column}`)} className="board-column" key={column}>
            <header className="board-column-heading">
              <h2>{t(`column.${column}`)}</h2>
              <span className="board-count">{cards.length}</span>
            </header>
            {cards.length === 0 ? (
              <p className="board-empty">{t('columnEmpty')}</p>
            ) : (
              <ul className="board-cards">
                {cards.map((row) => (
                  <li key={keyOf(row)}>{renderCard(row)}</li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}

/** One card. The whole card is the control, because the whole card is what a reader aims at. */
export function BoardCard({
  title,
  onOpen,
  label,
  children,
}: {
  title: string
  onOpen: () => void
  label: string
  children: ReactNode
}) {
  return (
    <button aria-label={label} className="board-card" onClick={onOpen} type="button">
      <strong className="board-card-title">{title}</strong>
      {children}
    </button>
  )
}
