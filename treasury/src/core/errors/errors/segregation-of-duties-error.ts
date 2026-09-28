import { UseCaseError } from '../use-case-error'

/**
 * One person would hold both duties of a declared pair on the same record (ADR 0062).
 * Every module answers it the same way: `403`, code `segregation-of-duties`, the pair named.
 */
export class SegregationOfDutiesError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/segregation-of-duties'
  readonly title = 'Segregation of duties'
  constructor(
    readonly pair: string,
    detail: string,
  ) {
    super(detail)
  }
}
