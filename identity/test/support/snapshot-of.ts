/** Snapshot inspection belongs at the test boundary, like persistence/presentation. */
export function snapshotOf<T>(entity: { toSnapshot(): T }): T {
  return entity.toSnapshot()
}
