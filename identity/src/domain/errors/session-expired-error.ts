import { UseCaseError } from '@/core/errors/use-case-error'

/** The refresh token is unknown, its family ended, or a lifetime elapsed (ADR 0020). */
export class SessionExpiredError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/session-expired'
  readonly title = 'Session expired'

  constructor(detail = 'this session is no longer valid; sign in again') {
    super(detail)
  }
}
