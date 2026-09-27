import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { LabelName, ListKind } from '../value-objects/crm-values'

interface ListEntryProps {
  tenantId: string
  kind: ListKind
  name: LabelName
  archived: boolean
  createdAt: Date
  updatedAt: Date
}

export interface ListEntrySnapshot {
  readonly id: string
  readonly tenantId: string
  readonly kind: ListKind
  readonly name: string
  readonly archived: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * One entry of a workspace list: where an account or opportunity came from (`source`) or
 * why an opportunity was lost (`loss-reason`). Archived, never deleted, so a record that
 * names it keeps meaning something.
 */
export class ListEntry extends AggregateRoot<ListEntryProps> {
  static create(
    props: { tenantId: string; kind: ListKind; name: LabelName; now: Date },
    id?: UniqueEntityID,
  ): ListEntry {
    return new ListEntry(
      { ...props, archived: false, createdAt: props.now, updatedAt: props.now },
      id,
    )
  }

  static rehydrate(props: ListEntryProps, id: UniqueEntityID): ListEntry {
    return new ListEntry(props, id)
  }

  get kind(): ListKind {
    return this.props.kind
  }

  get name(): LabelName {
    return this.props.name
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  /** May be chosen on a new record: an archived entry only stays where it already is. */
  isSelectable(): boolean {
    return !this.props.archived
  }

  rename(name: LabelName, now: Date): void {
    this.props.name = name
    this.props.updatedAt = now
  }

  setArchived(archived: boolean, now: Date): Either<ConflictError, void> {
    if (this.props.archived === archived)
      return left(
        new ConflictError(archived ? 'the entry is already archived' : 'the entry is not archived'),
      )
    this.props.archived = archived
    this.props.updatedAt = now
    return right(undefined)
  }

  toSnapshot(): Readonly<ListEntrySnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      kind: this.props.kind,
      name: this.props.name.value,
      archived: this.props.archived,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
