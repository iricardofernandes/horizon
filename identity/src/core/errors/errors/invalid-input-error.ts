import { UseCaseError } from '../use-case-error'

/**
 * A value that failed its own invariant — an email that is not an email, a timezone that
 * is not a zone. Returned by a value object's `create()`, so an invalid value cannot be
 * constructed at all rather than being validated somewhere downstream.
 *
 * `field` is a JSON Pointer so the filter can emit it as an RFC 9457 violation without
 * re-deriving where the failure came from.
 */
export class InvalidInputError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/invalid-input'
  readonly title = 'Invalid input'

  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(detail)
  }
}
