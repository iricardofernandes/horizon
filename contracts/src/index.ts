/**
 * @horizon/contracts — the one sanctioned coupling between modules (ADR 0002).
 *
 * Published to a registry with a semver version and consumed at a pinned version; never
 * linked from the filesystem, because a `file:` dependency has no version and therefore
 * cannot express a breaking change (ADR 0029).
 *
 * Nothing in a module's `domain/` imports this package — it is a wire format, not a
 * domain model, and the boundary check enforces the distinction.
 */

export * from './common'
export * from './envelope'
export * from './events'
export * from './http'
export * from './registry'
export * from './roles'
