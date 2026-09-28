/**
 * Saved views (Phase 66): a list screen's filters, sort and columns under a name, private
 * or shared with the workspace. A view holds no data, only a way to look at data the owning
 * module still authorizes.
 */

export interface SavedView {
  readonly viewId: string
  readonly screen: string
  readonly name: string
  /** The list's URL query string, without `?`. */
  readonly query: string
  /** The visible columns, where the screen lets a person choose; null otherwise. */
  readonly columns: readonly string[] | null
  readonly ownerId: string
  readonly shared: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type ViewInput = Pick<SavedView, 'screen' | 'name' | 'query' | 'columns' | 'shared'>

const SCREEN = /^[a-z][a-z-]*\.[a-z][a-z-]*$/
const COLUMN = /^[a-zA-Z][a-zA-Z0-9-]{0,39}$/

/** Why a view cannot be kept, or null. */
export function viewProblem(view: ViewInput): string | null {
  if (!SCREEN.test(view.screen)) return 'screen: must be <module>.<list>'
  const name = view.name.trim()
  if (name.length < 1 || name.length > 80) return 'name: 1 to 80 characters'
  if (view.query.length > 1000) return 'query: at most 1,000 characters'
  if (view.query.startsWith('?')) return 'query: without the leading ?'
  if ([...view.query].some((character) => (character.codePointAt(0) ?? 0) < 0x20))
    return 'query: no control characters'
  if (view.columns && (view.columns.length > 30 || !view.columns.every((c) => COLUMN.test(c))))
    return 'columns: up to 30 column names'
  return null
}

export function visibleTo(view: SavedView, userId: string): boolean {
  return view.shared || view.ownerId === userId
}
