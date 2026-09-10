import { UseCaseError } from '@/core/errors/use-case-error'

/**
 * The data-subject key is gone, so the ciphertext cannot be read by anyone (ADR 0026).
 *
 * A 404 would be a lie — the row is right there — and a 500 would suggest something is
 * broken. Erasure worked; that is what this says.
 */
export class SubjectErasedError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/subject-erased'
  readonly title = 'Data subject erased'

  constructor() {
    super('this data subject has been erased; the data is unrecoverable by design')
  }
}
