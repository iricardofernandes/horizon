import { UniqueEntityID } from './unique-entity-id'

/**
 * Identity, not attributes: two entities are the same entity when their ids match, no
 * matter how far their state has diverged.
 *
 * `equals()` compares through `UniqueEntityID.equals()`. The reference project compared
 * `entity.id === this._id`, which is reference equality on an object — so the same row
 * loaded twice compared unequal (`docs/reference-analysis.md` §3.1).
 */
export abstract class Entity<Props> {
  private readonly _id: UniqueEntityID
  protected props: Props

  protected constructor(props: Props, id?: UniqueEntityID) {
    this.props = props
    this._id = id ?? new UniqueEntityID()
  }

  get id(): UniqueEntityID {
    return this._id
  }

  equals(other: Entity<unknown>): boolean {
    if (other === this) return true
    return this._id.equals(other.id)
  }
}
