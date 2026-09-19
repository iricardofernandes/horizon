'use client'

import type { ReactNode } from 'react'

/**
 * Work in the columns it moves through.
 *
 * A board is for what still needs doing, so a column that is empty says so rather than
 * disappearing: a reader who learns "nothing waiting for approval" has learned something,
 * and a board whose columns move about between visits cannot be read at a glance.
 *
 * The labels are the caller's, because only the caller knows what its columns are called;
 * the arrangement is the same wherever work sits in states (ADR 0044).
 */
export function Board<T>({
  columns,
  rows,
  columnOf,
  labelOf,
  emptyLabel,
  renderCard,
  keyOf,
}: {
  columns: readonly string[]
  rows: readonly T[]
  columnOf: (row: T) => string
  labelOf: (column: string) => string
  emptyLabel: string
  renderCard: (row: T) => ReactNode
  keyOf: (row: T) => string
}) {
  return (
    <div className="board">
      {columns.map((column) => {
        const cards = rows.filter((row) => columnOf(row) === column)
        return (
          <section aria-label={labelOf(column)} className="board-column" key={column}>
            <header className="board-column-heading">
              <h2>{labelOf(column)}</h2>
              <span className="board-count">{cards.length}</span>
            </header>
            {cards.length === 0 ? (
              <p className="board-empty">{emptyLabel}</p>
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
