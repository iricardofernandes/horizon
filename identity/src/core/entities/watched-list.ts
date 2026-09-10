/**
 * A child collection that remembers what it started as, so a repository can issue a
 * minimal diff on `save()` rather than deleting and reinserting the whole set.
 *
 * The three-line subclass idiom — declare only `compareItems` — is the reference
 * project's, kept verbatim.
 */
export abstract class WatchedList<T> {
  private currentItems: T[]
  private initial: T[]
  private new: T[] = []
  private removed: T[] = []

  protected constructor(initialItems: readonly T[] = []) {
    this.currentItems = [...initialItems]
    this.initial = [...initialItems]
  }

  abstract compareItems(a: T, b: T): boolean

  getItems(): readonly T[] {
    return this.currentItems
  }

  getNewItems(): readonly T[] {
    return this.new
  }

  getRemovedItems(): readonly T[] {
    return this.removed
  }

  exists(item: T): boolean {
    return this.currentItems.some((current) => this.compareItems(current, item))
  }

  add(item: T): void {
    if (this.isRemoved(item)) this.removeFrom('removed', item)
    if (!this.isNew(item) && !this.wasInitial(item)) this.new.push(item)
    if (!this.exists(item)) this.currentItems.push(item)
  }

  remove(item: T): void {
    if (this.isNew(item)) this.removeFrom('new', item)
    if (this.wasInitial(item) && !this.isRemoved(item)) this.removed.push(item)
    this.currentItems = this.currentItems.filter((current) => !this.compareItems(current, item))
  }

  update(items: readonly T[]): void {
    for (const item of this.currentItems.filter((c) => !items.some((i) => this.compareItems(c, i))))
      this.remove(item)
    for (const item of items.filter((i) => !this.exists(i))) this.add(item)
  }

  private isNew(item: T): boolean {
    return this.new.some((current) => this.compareItems(current, item))
  }

  private isRemoved(item: T): boolean {
    return this.removed.some((current) => this.compareItems(current, item))
  }

  private wasInitial(item: T): boolean {
    return this.initial.some((current) => this.compareItems(current, item))
  }

  private removeFrom(list: 'new' | 'removed', item: T): void {
    this[list] = this[list].filter((current) => !this.compareItems(current, item))
  }
}
