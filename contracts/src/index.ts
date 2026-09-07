/**
 * @horizon/contracts — the one sanctioned coupling between modules (ADR 0002).
 *
 * Published to a registry with a semver version and consumed at a pinned version;
 * never linked from the filesystem, because a `file:` dependency has no version and
 * therefore cannot express a breaking change (ADR 0029).
 *
 * Contents arrive in phase 3:
 *   - the event envelope schema
 *   - per-event payload schemas, versioned per ADR 0030
 *   - cross-module HTTP payload schemas
 *   - per-module role and permission name maps
 */

export {}
