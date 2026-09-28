import { UseCaseError } from '../use-case-error'

/** The person holds neither the role nor a delegation that allows this decision. */
export class NotAllowedError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/forbidden'
  readonly title = 'Forbidden'
  constructor(detail: string) {
    super(detail)
  }
}
