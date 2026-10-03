/** The timezone a workspace's day is told in until it states its own (ADR 0077). */
const BUSINESS_TIME_ZONE = 'America/Sao_Paulo'
// `en-CA` writes a date as YYYY-MM-DD.
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * The calendar day an instant falls on where the business is. The domain keeps its own copy
 * of the rule `@horizon/contracts` states for the other layers, which it may not import.
 */
export function businessDayOf(instant: Date): string {
  return dayFormat.format(instant)
}
