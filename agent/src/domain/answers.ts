/**
 * What the assistant says, and on what (Phase 76): every statement names the sources it
 * rests on, and a statement that names none it read is not an answer but "not found".
 */

/** Something a tool answered, which a statement can cite. */
export type Source =
  | {
      readonly id: string
      readonly kind: 'document'
      readonly attachmentId: string
      readonly record: {
        readonly module: string
        readonly recordType: string
        readonly recordId: string
      }
      readonly screen: string
      readonly position: { readonly chunk: number; readonly of: number }
      readonly excerpt: string
    }
  | {
      readonly id: string
      readonly kind: 'record'
      readonly tool: string
      readonly module: string
      readonly screen: string
      /** Rows the tool answered, when it answered a list. */
      readonly rows: number | null
    }

export interface Statement {
  readonly text: string
  readonly sources: readonly string[]
  /** False when none of its sources is one the assistant read: shown as not found. */
  readonly found: boolean
}

export const MAX_STATEMENTS = 20
export const MAX_STATEMENT_LENGTH = 2000

/**
 * The model's statements, kept only with sources that exist; the rest marked not found.
 * Anything that is not a statement is dropped, and nothing beyond the caps is kept.
 */
export function resolveStatements(proposed: unknown, known: ReadonlySet<string>): Statement[] {
  const list =
    proposed !== null &&
    typeof proposed === 'object' &&
    Array.isArray((proposed as { statements?: unknown }).statements)
      ? ((proposed as { statements: unknown[] }).statements as unknown[])
      : []
  return list.slice(0, MAX_STATEMENTS).flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const { text, sources } = entry as { text?: unknown; sources?: unknown }
    if (typeof text !== 'string' || !text.trim()) return []
    const cited = Array.isArray(sources)
      ? [...new Set(sources.filter((id): id is string => typeof id === 'string' && known.has(id)))]
      : []
    return [
      { text: text.trim().slice(0, MAX_STATEMENT_LENGTH), sources: cited, found: cited.length > 0 },
    ]
  })
}

/** The first day of an instant's month, UTC: the budget's period. */
export function monthOf(at: Date): string {
  return `${at.toISOString().slice(0, 7)}-01`
}

/** The screen that lists a module's records, for a source that came from a record tool. */
export function moduleScreen(module: string): string {
  const screens: Readonly<Record<string, string>> = {
    parties: '/app/registrations/parties',
    catalog: '/app/catalog/items',
    sales: '/app/sales/orders',
    inventory: '/app/inventory/balances',
    procurement: '/app/purchasing/orders',
    financial: '/app/finance/payables',
    treasury: '/app/finance/treasury',
    crm: '/app/crm/pipeline',
    fiscal: '/app/fiscal/documents',
    reporting: '/app/reports',
  }
  return screens[module] ?? '/app'
}
