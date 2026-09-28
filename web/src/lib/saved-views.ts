/**
 * Saved views on the web (Phase 66): a list's filters as a query string, and the columns a
 * person chose. The view is kept by Reporting; the list still comes from its module.
 */

export type SavedView = {
  id: string
  screen: string
  name: string
  query: string
  columns: string[] | null
  shared: boolean
  mine: boolean
}

/** The filters as a stable query string: empty values left out, keys in order. */
export function queryOf(filters: Readonly<Record<string, string | null | undefined>>): string {
  const params = new URLSearchParams()
  for (const key of Object.keys(filters).sort()) {
    const value = filters[key]
    if (value !== null && value !== undefined && value !== '') params.set(key, value)
  }
  return params.toString()
}

export function filtersOf(query: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(query))
}

/** The columns to show: all of them when no choice was made, else the chosen ones in order. */
export function shownColumns<C extends string>(
  all: readonly C[],
  chosen: readonly string[] | null,
) {
  if (!chosen) return [...all]
  const known = all.filter((column) => chosen.includes(column))
  return known.length > 0 ? known : [...all]
}

/** Whether the screen is showing exactly what a view holds. */
export function isCurrent(
  view: Pick<SavedView, 'query' | 'columns'>,
  query: string,
  columns: readonly string[] | null,
) {
  return (
    view.query === query && JSON.stringify(view.columns ?? null) === JSON.stringify(columns ?? null)
  )
}
