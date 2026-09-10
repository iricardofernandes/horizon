/**
 * The base of every *expected* failure — the ones a use case returns on the left of an
 * `Either` because a caller must handle them (ADR 0032).
 *
 * A fault is not one of these. A null dereference, a broken invariant or an unreachable
 * database is thrown, propagates, and becomes a 500 with the context logged; nobody can
 * handle those locally, and pretending otherwise produces `catch` blocks that swallow.
 *
 * `type` is the RFC 9457 problem type URI. It is declared on the error, not chosen by a
 * controller, so a new failure mode is one class plus one filter entry.
 */
export abstract class UseCaseError extends Error {
  /** Machine-readable problem type. Clients branch on this, never on the message. */
  abstract readonly type: string

  /** Short, stable summary for the given `type`. */
  abstract readonly title: string

  protected constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}
