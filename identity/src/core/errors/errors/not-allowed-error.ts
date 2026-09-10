import { UseCaseError } from '../use-case-error'

export class NotAllowedError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/not-allowed'
  readonly title = 'Not allowed'

  constructor(action = 'You are not allowed to perform this action') {
    super(action)
  }
}
