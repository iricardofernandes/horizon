export type WorkspaceLine = {
  id: string
  postedOn: string
  amount: string
  open: string
  status: 'unmatched' | 'partial' | 'matched' | 'ignored'
  bankReference: string | null
  documentId: string | null
  description: string
  counterparty: string | null
}

export type WorkspaceEntry = {
  id: string
  valueOn: string
  amount: string
  open: string
  status: 'unmatched' | 'partial' | 'matched'
  source: string
  counterparty: string | null
  memo: string | null
}

export type SuggestionReason =
  | { code: 'amount-exact' }
  | { code: 'amount-sum'; parts: number }
  | { code: 'date'; days: number }
  | { code: 'document'; document: string }
  | { code: 'counterparty'; percent: number }
  | { code: 'text'; percent: number }

export type Suggestion = {
  key: string
  shape: '1:1' | '1:N' | 'N:1'
  statementLineIds: string[]
  entryIds: string[]
  score: number
  reasons: SuggestionReason[]
}

export type ReconciliationRecord = {
  id: string
  kind: 'match' | 'ignore'
  origin: 'manual' | 'suggestion'
  suggestionScore: number | null
  corrected: boolean
  reason: string | null
  status: 'active' | 'undone'
  confirmedAt: string
  undoReason: string | null
  items: { kind: 'statement' | 'entry'; id: string; applied: string; date: string }[]
}

export type Workspace = {
  from: string
  to: string
  closure: { id: string; through: string; closedAt: string } | null
  summary: {
    bookOpening: string
    bookClosing: string
    statementTotal: string
    ignoredTotal: string
    unmatchedStatement: string
    entryTotal: string
    unmatchedEntries: string
    crossPeriod: string
    difference: string
  }
  lines: WorkspaceLine[]
  entries: WorkspaceEntry[]
  suggestions: Suggestion[]
  reconciliations: ReconciliationRecord[]
}

export type Metrics = {
  accepted: number
  corrected: number
  manual: number
  ignored: number
  undone: number
  dismissed: number
  acceptanceRate: number | null
}

export type ReconciliationAbilities = { canRecord: boolean; canUndo: boolean; canClose: boolean }

/** Signed minor units selected on one side: the whole open amount of every selected row. */
export function selectedTotal(
  rows: readonly { id: string; open: string }[],
  ids: ReadonlySet<string>,
): bigint {
  return rows.filter((row) => ids.has(row.id)).reduce((sum, row) => sum + BigInt(row.open), 0n)
}

export const isOpen = (row: { status: string }) =>
  row.status === 'unmatched' || row.status === 'partial'

/** `statement.csv` → csv; anything that is not recognisably CSV is read as OFX. */
export function formatOf(fileName: string): 'ofx' | 'csv' {
  return fileName.toLowerCase().endsWith('.csv') ? 'csv' : 'ofx'
}
