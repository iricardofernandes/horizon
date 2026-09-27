import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { ActivityKind, RecordText, Subject } from '../value-objects/record-values'

/** What a person may say about an activity; the title and summary are sealed text. */
export interface ActivityDetails {
  readonly kind: ActivityKind
  readonly occurredAt: Date
  readonly title: RecordText
  readonly summary: RecordText | null
  readonly contactIds: readonly string[]
}

interface ActivityProps extends ActivityDetails {
  tenantId: string
  accountId: string
  subject: Subject
  recordedBy: string
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface ActivitySnapshot {
  readonly id: string
  readonly tenantId: string
  readonly accountId: string
  readonly subject: Subject
  readonly kind: ActivityKind
  readonly occurredAt: Date
  readonly title: string
  readonly summary: string | null
  readonly contactIds: readonly string[]
  readonly recordedBy: string
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

type DetailField = keyof ActivityDetails

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join()
}

/**
 * A call, meeting, email or visit that happened with an account (Phase 57). It is a
 * record of the past, so it is corrected rather than deleted; the audit log keeps which
 * fields a correction changed, never their text.
 */
export class Activity extends AggregateRoot<ActivityProps> {
  static record(
    props: ActivityDetails & {
      tenantId: string
      accountId: string
      subject: Subject
      recordedBy: string
      now: Date
    },
    id?: UniqueEntityID,
  ): Activity {
    const { now, ...details } = props
    return new Activity(
      {
        ...details,
        contactIds: [...new Set(props.contactIds)],
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      id,
    )
  }

  static rehydrate(props: ActivityProps, id: UniqueEntityID): Activity {
    return new Activity(props, id)
  }

  get accountId(): string {
    return this.props.accountId
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  /** Replace what was recorded; returns the names of the fields that changed. */
  revise(details: ActivityDetails, now: Date): readonly DetailField[] {
    const contactIds = [...new Set(details.contactIds)]
    const changed = (
      [
        ['kind', details.kind === this.props.kind],
        ['occurredAt', details.occurredAt.getTime() === this.props.occurredAt.getTime()],
        ['title', details.title.equals(this.props.title)],
        [
          'summary',
          details.summary === null
            ? this.props.summary === null
            : details.summary.equals(this.props.summary),
        ],
        ['contactIds', sameIds(contactIds, this.props.contactIds)],
      ] as const
    )
      .filter(([, unchanged]) => !unchanged)
      .map(([field]) => field)
    if (!changed.length) return changed
    Object.assign(this.props, { ...details, contactIds })
    this.props.version += 1
    this.props.updatedAt = now
    return changed
  }

  toSnapshot(): Readonly<ActivitySnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      accountId: this.props.accountId,
      subject: this.props.subject,
      kind: this.props.kind,
      occurredAt: this.props.occurredAt,
      title: this.props.title.value,
      summary: this.props.summary?.value ?? null,
      contactIds: [...this.props.contactIds],
      recordedBy: this.props.recordedBy,
      version: this.props.version,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
