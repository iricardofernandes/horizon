import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

/** What an activity, a task or a note is about (Phase 57). */
export const SUBJECT_TYPES = ['account', 'contact', 'opportunity'] as const
export type SubjectType = (typeof SUBJECT_TYPES)[number]

export interface Subject {
  readonly type: SubjectType
  readonly id: string
}

export function subjectOf(type: string, id: string): Either<InvalidInputError, Subject> {
  return SUBJECT_TYPES.includes(type as SubjectType)
    ? right({ type: type as SubjectType, id })
    : left(new InvalidInputError('/subject/type', `must be one of ${SUBJECT_TYPES.join(', ')}`))
}

/** How the business talked to the account. Recorded, never captured (CRM plan). */
export const ACTIVITY_KINDS = ['call', 'meeting', 'email', 'visit'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export function activityKindOf(value: string): Either<InvalidInputError, ActivityKind> {
  return ACTIVITY_KINDS.includes(value as ActivityKind)
    ? right(value as ActivityKind)
    : left(new InvalidInputError('/kind', `must be one of ${ACTIVITY_KINDS.join(', ')}`))
}

/**
 * Free text a person writes on a record: an activity's title or summary, a task's title,
 * a note. It may name a person, so it is sealed under the account's key and never
 * published (Phase 57).
 *
 * A single line collapses its whitespace; a long text keeps its line breaks but not
 * trailing spaces or more than one blank line in a row.
 */
export class RecordText extends ValueObject<{ value: string }> {
  static line(
    value: string,
    field: string,
    min = 2,
    max = 160,
  ): Either<InvalidInputError, RecordText> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    return RecordText.bounded(normalized, field, min, max)
  }

  static long(value: string, field: string, max: number): Either<InvalidInputError, RecordText> {
    const normalized = value
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return RecordText.bounded(normalized, field, 1, max)
  }

  private static bounded(
    value: string,
    field: string,
    min: number,
    max: number,
  ): Either<InvalidInputError, RecordText> {
    if (value.length < min || value.length > max)
      return left(new InvalidInputError(field, `must contain between ${min} and ${max} characters`))
    return right(new RecordText({ value }))
  }

  get value(): string {
    return this.props.value
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.value]
  }
}

export const MAX_SUMMARY = 4000
export const MAX_NOTE = 10_000

const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/

/** Whether the written calendar fields exist as written: no 30 February, no 24:00. */
function calendarHolds(match: RegExpExecArray): boolean {
  const [, year, month, day, hour, minute, second = '0', offsetHour = '0', offsetMinute = '0'] =
    match.map((part) => part ?? undefined)
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 60 &&
    Number(offsetHour) < 24 &&
    Number(offsetMinute) < 60
  )
}

/** An instant as the API receives it: ISO 8601 with an offset, stored as UTC (ADR 0011). */
export function instantOf(value: string, field: string): Either<InvalidInputError, Date> {
  const match = INSTANT.exec(value)
  if (!match || !calendarHolds(match))
    return left(new InvalidInputError(field, 'must be an ISO 8601 instant with an offset'))
  return right(new Date(value))
}
