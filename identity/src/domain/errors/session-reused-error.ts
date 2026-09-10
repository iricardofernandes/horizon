import { UseCaseError } from '@/core/errors/use-case-error'

/**
 * A rotated refresh token was replayed outside the grace window (ADR 0020).
 *
 * Distinct from `SessionExpiredError` because the consequence is different and the client
 * should say so: the whole family was destroyed, including the legitimate holder's, and
 * the user is being asked to re-authenticate because a theft was detected rather than
 * because time passed.
 */
export class SessionReusedError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/session-reuse-detected'
  readonly title = 'Session reuse detected'

  constructor() {
    super('a rotated refresh token was replayed; the session family has been destroyed')
  }
}
