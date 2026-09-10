import { UseCaseError } from '@/core/errors/use-case-error'

/** Signature, claims and lifetime failures deliberately share one authentication error. */
export class InvalidAccessTokenError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/invalid-access-token'
  readonly title = 'Invalid access token'

  constructor() {
    super('access token is invalid or expired')
  }
}
