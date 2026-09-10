/**
 * `Either` — the return type of every use case (ADR 0032).
 *
 * Thirty lines, copied into each module rather than shared, for the reason in ADR 0031.
 * The load-bearing detail is that `isLeft()` and `isRight()` are **type predicates**:
 * after `if (result.isLeft())` the compiler knows `result.value` is the error, and after
 * the early return it knows it is the value. Exhaustive narrowing without a library.
 */

export class Left<L, R> {
  constructor(readonly value: L) {}

  isLeft(): this is Left<L, R> {
    return true
  }

  isRight(): this is Right<L, R> {
    return false
  }
}

export class Right<L, R> {
  constructor(readonly value: R) {}

  isLeft(): this is Left<L, R> {
    return false
  }

  isRight(): this is Right<L, R> {
    return true
  }
}

export type Either<L, R> = Left<L, R> | Right<L, R>

export function left<L, R>(value: L): Either<L, R> {
  return new Left(value)
}

export function right<L, R>(value: R): Either<L, R> {
  return new Right(value)
}
