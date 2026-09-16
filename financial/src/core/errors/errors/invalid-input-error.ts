import { UseCaseError } from '../use-case-error'

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
