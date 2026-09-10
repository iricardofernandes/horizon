import { ValueObject } from '@/core/entities/value-object'

/**
 * A `{ module, role }` pair, held **opaquely**.
 *
 * Identity stores these and cannot expand them into permissions — that is the whole
 * point of ADR 0023's two-dimensional model. Compromising identity yields role *names*;
 * expansion happens in the module that owns the subject, against its own static map.
 *
 * Which names are legal is a wire-contract question, so it is answered by
 * `@horizon/contracts` at the HTTP boundary. It is deliberately not answered here:
 * `domain/` imports no schema library (ADR 0031), and a second copy of the role table in
 * this file would be a second copy to keep in sync.
 */
export interface RoleAssignment {
  readonly module: string
  readonly role: string
}

/**
 * First-class collection (ADR 0031, calisthenics rule 4): it holds the assignments and
 * nothing else, and it carries their behaviour.
 */
export class RoleAssignments extends ValueObject<{ readonly pairs: readonly RoleAssignment[] }> {
  static empty(): RoleAssignments {
    return new RoleAssignments({ pairs: [] })
  }

  static of(pairs: readonly RoleAssignment[]): RoleAssignments {
    return new RoleAssignments({ pairs: RoleAssignments.canonical(pairs) })
  }

  /**
   * Sorted and deduplicated. Two users granted the same roles in a different order hold
   * an equal collection, and the token they are minted carries a stable claim — which
   * means a token diff is a permission diff rather than an ordering artefact.
   */
  private static canonical(pairs: readonly RoleAssignment[]): readonly RoleAssignment[] {
    const unique = new Map<string, RoleAssignment>()
    for (const pair of pairs) unique.set(`${pair.module}:${pair.role}`, pair)
    return [...unique.values()].sort((a, b) =>
      a.module === b.module ? a.role.localeCompare(b.role) : a.module.localeCompare(b.module),
    )
  }

  get pairs(): readonly RoleAssignment[] {
    return this.props.pairs
  }

  get isEmpty(): boolean {
    return this.props.pairs.length === 0
  }

  has(module: string, role: string): boolean {
    return this.props.pairs.some((pair) => pair.module === module && pair.role === role)
  }

  hasAnyIn(module: string): boolean {
    return this.props.pairs.some((pair) => pair.module === module)
  }

  rolesIn(module: string): readonly string[] {
    return this.props.pairs.filter((pair) => pair.module === module).map((pair) => pair.role)
  }

  /** Immutable: granting returns a new collection (ADR 0031). */
  grant(assignment: RoleAssignment): RoleAssignments {
    return RoleAssignments.of([...this.props.pairs, assignment])
  }

  revoke(assignment: RoleAssignment): RoleAssignments {
    return RoleAssignments.of(
      this.props.pairs.filter(
        (pair) => !(pair.module === assignment.module && pair.role === assignment.role),
      ),
    )
  }

  protected componentsOf(): readonly unknown[] {
    return this.props.pairs.map((pair) => `${pair.module}:${pair.role}`)
  }
}
