import { UseCaseError } from '../use-case-error'

export class ResourceNotFoundError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/resource-not-found'
  readonly title = 'Resource not found'
  // biome-ignore lint/complexity/noUselessConstructor: exposes the protected base constructor.
  constructor(detail: string) {
    super(detail)
  }
}
