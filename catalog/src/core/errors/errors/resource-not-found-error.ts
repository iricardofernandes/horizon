import { UseCaseError } from '../use-case-error'

export class ResourceNotFoundError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/resource-not-found'
  readonly title = 'Resource not found'
  constructor(resource: string) {
    super(`${resource} not found`)
  }
}
