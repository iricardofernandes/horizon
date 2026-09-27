import { UseCaseError } from '../use-case-error'

export class ConflictError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/conflict'
  readonly title = 'Conflict'
  // biome-ignore lint/complexity/noUselessConstructor: exposes the protected base constructor.
  constructor(detail: string) {
    super(detail)
  }
}
