/**
 * Equality by value, not identity. Two `Email`s holding the same address are the same
 * email.
 *
 * Comparison is structural and declared by the subclass through `componentsOf()`, rather
 * than the reference's `JSON.stringify` comparison — which is property-order dependent,
 * silently wrong for `Date`, `undefined`, `Map` and `Set`, and throws outright on
 * `bigint`, which Horizon's `Money` is backed by (`docs/reference-analysis.md` §3.2).
 */
export abstract class ValueObject<Props> {
  protected readonly props: Props

  protected constructor(props: Props) {
    this.props = Object.freeze(props)
  }

  /**
   * The values that make this object what it is, in a fixed order. Primitives only —
   * a nested value object contributes its own components.
   */
  protected abstract componentsOf(): readonly unknown[]

  equals(other: ValueObject<Props> | null | undefined): boolean {
    if (other === null || other === undefined) return false
    if (other === this) return true
    // Two value objects of different classes are never equal, even with identical
    // components: a `Cnpj` and a `DocumentNumber` holding the same digits are not
    // interchangeable, and that is the entire reason each is its own type.
    if (other.constructor !== this.constructor) return false

    const mine = this.componentsOf()
    const theirs = other.componentsOf()
    if (mine.length !== theirs.length) return false

    return mine.every((component, index) => Object.is(component, theirs[index]))
  }
}
