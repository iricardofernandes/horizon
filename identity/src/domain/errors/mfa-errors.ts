import { UseCaseError } from '@/core/errors/use-case-error'

/** Too many wrong second factors: the account's second factor is locked for a while. */
export class MfaLockedError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/mfa-locked'
  readonly title = 'Second factor locked'

  constructor(detail = 'too many wrong codes; try again in 15 minutes') {
    super(detail)
  }
}

/** A sensitive action asks the person to prove who they are again (ADR 0061 §4). */
export class StepUpRequiredError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/step-up-required'
  readonly title = 'Step-up required'

  constructor(detail = 'confirm your password and second factor to do this') {
    super(detail)
  }
}

/**
 * The workspace requires a second factor and the grace period ended. The enrollment token
 * allows only enrolling one.
 */
export class MfaEnrollmentRequiredError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/mfa-enrollment-required'
  readonly title = 'Second factor required'
  readonly extensions: Readonly<Record<string, unknown>>

  constructor(enrollmentToken: string, expiresAt: Date) {
    super('this workspace requires a second factor; enroll one, then sign in again')
    this.extensions = { enrollmentToken, enrollmentExpiresAt: expiresAt.toISOString() }
  }
}

/** An invitation link that is unknown, used, revoked or expired: refused alike. */
export class InvitationUnusableError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/invitation-unusable'
  readonly title = 'Invitation unusable'

  constructor(detail = 'this invitation link is no longer valid; ask for a new one') {
    super(detail)
  }
}

/** The mail could not be sent; the invitation stays and can be resent. */
export class MailUnavailableError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/mail-unavailable'
  readonly title = 'Mail unavailable'

  constructor(detail = 'the invitation was kept but its email could not be sent; resend it') {
    super(detail)
  }
}
