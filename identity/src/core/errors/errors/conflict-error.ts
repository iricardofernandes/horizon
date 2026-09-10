import { UseCaseError } from '../use-case-error'

/** The request is well-formed but contradicts current state — a duplicate email, a
 * tenant slug already taken. Distinct from invalid input, because retrying with the same
 * body will keep failing until something else changes. */
export class ConflictError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/conflict'
  readonly title = 'Conflict'

  // biome-ignore lint/complexity/noUselessConstructor: the protected base constructor must become public.
  constructor(detail: string) {
    super(detail)
  }
}
