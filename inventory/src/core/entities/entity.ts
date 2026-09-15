import { UniqueEntityID } from './unique-entity-id'

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
    return other === this || this._id.equals(other.id)
  }
}
