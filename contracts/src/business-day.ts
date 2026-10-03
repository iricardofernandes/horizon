/** The timezone a workspace's day is told in until it states its own. */
export const DEFAULT_BUSINESS_TIME_ZONE = 'America/Sao_Paulo'

const formatters = new Map<string, Intl.DateTimeFormat>()

/**
 * The calendar day an instant falls on where the business is (Phase 92), as `YYYY-MM-DD`.
 * A title is overdue, a lot expires and a period closes by the workspace's day: at 22:00
 * in São Paulo it is still today there, though already tomorrow in UTC.
 */
export function businessDayOf(
  instant: Date,
  timeZone: string = DEFAULT_BUSINESS_TIME_ZONE,
): string {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    // `en-CA` writes a date as YYYY-MM-DD.
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter.format(instant)
}
