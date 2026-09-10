import { UseCaseError } from '@/core/errors/use-case-error'

/**
 * The ADR 0022 subset rule, refused: a user cannot mint a key more powerful than
 * themselves.
 *
 * The modules that put the key out of reach are named, because "insufficient scope" with
 * no detail turns a five-second fix into a support ticket.
 */
export class ScopeBeyondIssuerError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/scope-beyond-issuer'
  readonly title = 'Scope exceeds what you can grant'

  constructor(readonly modules: readonly string[]) {
    super(
      `you hold no role in ${modules.join(', ')}, so a key cannot be granted access to ` +
        'it — a key is never more powerful than the user who issued it',
    )
  }
}
