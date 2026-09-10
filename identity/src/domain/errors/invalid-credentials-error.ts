import { UseCaseError } from '@/core/errors/use-case-error'

/**
 * Wrong password, unknown account, or a tenant that does not exist — deliberately
 * indistinguishable.
 *
 * One error class for three causes is the point: three classes would map to three
 * responses, and the difference between them is an account-enumeration oracle. The
 * distinction is recorded in the audit log, where only an operator can read it.
 */
export class InvalidCredentialsError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/invalid-credentials'
  readonly title = 'Invalid credentials'

  constructor() {
    super('email or password is incorrect')
  }
}
