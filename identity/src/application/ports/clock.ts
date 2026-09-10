/**
 * Time, as a dependency.
 *
 * Every use case takes `now` from here and passes it into the aggregate, rather than the
 * aggregate calling `new Date()`. Token lifetimes, the refresh grace window and the
 * `last_used_at` throttle are all time arithmetic that has to be testable without
 * sleeping through it.
 */
export abstract class Clock {
  abstract now(): Date
}
