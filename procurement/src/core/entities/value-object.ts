export abstract class ValueObject<Props> {
  protected readonly props: Props
  protected constructor(props: Props) {
    this.props = Object.freeze(props)
  }
  protected abstract componentsOf(): readonly unknown[]
  equals(other: ValueObject<Props> | null | undefined): boolean {
    if (other === null || other === undefined || other.constructor !== this.constructor)
      return false
    if (other === this) return true
    const mine = this.componentsOf()
    const theirs = other.componentsOf()
    return (
      mine.length === theirs.length && mine.every((part, index) => Object.is(part, theirs[index]))
    )
  }
}
