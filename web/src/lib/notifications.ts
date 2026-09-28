/** The bell's side of notifications (Phase 66): what a notification carries to be read. */

export type NotificationKind =
  | 'task-due'
  | 'approval-requisition'
  | 'approval-order'
  | 'approval-payable'
  | 'import-finished'
  | 'billing-run-finished'
  | 'file-quarantined'
  | 'export-finished'
  | 'reconciliation-different'

export type NotificationItem = {
  id: string
  kind: NotificationKind
  params: Record<string, string | number | null>
  link: string | null
  createdAt: string
  read: boolean
}

/** The ICU values of a notification's message: its params, with blanks for what is missing. */
export function paramsOf(item: NotificationItem): Record<string, string | number> {
  const values: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(item.params)) values[key] = value ?? ''
  if (typeof item.params.amount === 'string') values.amount = majorUnits(item.params.amount)
  return values
}

/** Minor units as a decimal of two places, for a message that names an amount. */
export function majorUnits(minor: string): string {
  if (!/^-?\d+$/.test(minor)) return minor
  const negative = minor.startsWith('-')
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`
}
