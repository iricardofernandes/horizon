export function snapshotOf<T>(aggregate: { toSnapshot(): Readonly<T> }): Readonly<T> {
  return aggregate.toSnapshot()
}
