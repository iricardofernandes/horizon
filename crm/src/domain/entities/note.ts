import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { RecordText, Subject } from '../value-objects/record-values'

export interface NoteRevision {
  readonly revision: number
  readonly body: RecordText
  readonly author: string
  readonly writtenAt: Date
}

interface NoteProps {
  tenantId: string
  accountId: string
  subject: Subject
  /** Every revision, oldest first; the last is what the note says now. */
  revisions: NoteRevision[]
  createdAt: Date
}

export interface NoteSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly accountId: string
  readonly subject: Subject
  readonly body: string
  readonly revisions: readonly {
    readonly revision: number
    readonly body: string
    readonly author: string
    readonly writtenAt: Date
  }[]
  readonly createdAt: Date
}

/**
 * Something a person wrote about an account (Phase 57). A note is never edited in place:
 * a correction appends a revision, and every earlier text stays in its history.
 */
export class Note extends AggregateRoot<NoteProps> {
  private pending: NoteRevision[] = []

  static write(
    props: {
      tenantId: string
      accountId: string
      subject: Subject
      body: RecordText
      author: string
      now: Date
    },
    id?: UniqueEntityID,
  ): Note {
    const first = { revision: 1, body: props.body, author: props.author, writtenAt: props.now }
    const note = new Note(
      {
        tenantId: props.tenantId,
        accountId: props.accountId,
        subject: props.subject,
        revisions: [first],
        createdAt: props.now,
      },
      id,
    )
    note.pending.push(first)
    return note
  }

  static rehydrate(props: NoteProps, id: UniqueEntityID): Note {
    if (!props.revisions.length) throw new Error('a note has at least one revision')
    return new Note(props, id)
  }

  get accountId(): string {
    return this.props.accountId
  }

  get current(): NoteRevision {
    const last = this.props.revisions.at(-1)
    if (!last) throw new Error('a note has at least one revision')
    return last
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  /** Append a revision; the same text as now is not a correction. */
  correct(body: RecordText, author: string, now: Date): Either<ConflictError, number> {
    if (body.equals(this.current.body)) return left(new ConflictError('the note already says this'))
    const revision = { revision: this.current.revision + 1, body, author, writtenAt: now }
    this.props.revisions.push(revision)
    this.pending.push(revision)
    return right(revision.revision)
  }

  /** Revisions written since the note was loaded, for the repository; cleared when read. */
  pullNewRevisions(): readonly NoteRevision[] {
    const revisions = this.pending
    this.pending = []
    return revisions
  }

  toSnapshot(): Readonly<NoteSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      accountId: this.props.accountId,
      subject: this.props.subject,
      body: this.current.body.value,
      revisions: this.props.revisions.map((revision) => ({
        revision: revision.revision,
        body: revision.body.value,
        author: revision.author,
        writtenAt: revision.writtenAt,
      })),
      createdAt: this.props.createdAt,
    })
  }
}
