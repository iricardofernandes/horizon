import { UseCaseError } from '../use-case-error'

export class ForbiddenError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/forbidden'
  readonly title = 'Forbidden'
  // biome-ignore lint/complexity/noUselessConstructor: exposes the protected base constructor.
  constructor(detail: string) {
    super(detail)
  }
}
