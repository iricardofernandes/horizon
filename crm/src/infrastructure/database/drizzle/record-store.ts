import { randomBytes } from 'node:crypto'
import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import { Activity } from '@/domain/entities/activity'
import { Note } from '@/domain/entities/note'
import { Task, type TaskStatus } from '@/domain/entities/task'
import type {
  ActivitiesRepository,
  NotesRepository,
  TasksRepository,
} from '@/domain/repositories/crm-repositories'
import type { SecretBox } from '@/domain/services/secret-box'
import {
  type ActivityKind,
  MAX_NOTE,
  MAX_SUMMARY,
  RecordText,
  type Subject,
  type SubjectType,
} from '@/domain/value-objects/record-values'
import type { Transaction } from './crm-store'
import * as schema from './schema'

/** What a record of an erased account reads as inside a command: its text is gone. */
export const ERASED_TEXT = 'Erased'

function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted CRM record', { cause: result.value })
  return result.value
}

/**
 * Seals the free text of an account's records under the account's own key (Phase 57).
 * The additional data binds each ciphertext to its tenant, account, record and field, so
 * a sealed value cannot be moved to another record and still open.
 */
export class AccountSealer {
  constructor(private readonly secretBox: SecretBox) {}

  seal(key: SealKey, record: string, field: string, value: string): string {
    return this.secretBox.seal(this.context(key, record, field), value)
  }

  open(key: SealKey, record: string, field: string, sealed: string): string {
    const plaintext = this.secretBox.open(this.context(key, record, field), sealed)
    if (plaintext === null) throw new Error('Account record text authentication failed')
    return plaintext
  }

  private context(key: SealKey, record: string, field: string): string {
    return `${key.tenantId}:${key.accountId}:${record}:${field}:${key.material}`
  }
}

export interface SealKey {
  readonly tenantId: string
  readonly accountId: string
  readonly material: string
}

/**
 * The account keys one transaction has looked up. `null` means the account has no key
 * readable any more — never created, or destroyed with its party.
 */
export class KeyRing {
  readonly #known = new Map<string, string | null>()

  constructor(
    private readonly tx: Transaction,
    private readonly tenantId: string,
    readonly sealer: AccountSealer,
  ) {}

  async keyOf(accountId: string): Promise<SealKey | null> {
    if (!this.#known.has(accountId)) {
      const [row] = await this.tx
        .select({ material: schema.accountDataKeys.material })
        .from(schema.accountDataKeys)
        .where(eq(schema.accountDataKeys.id, accountId))
        .limit(1)
      this.#known.set(accountId, row?.material ?? null)
    }
    const material = this.#known.get(accountId) ?? null
    return material === null ? null : { tenantId: this.tenantId, accountId, material }
  }

  /** The account's key, created with its first record. An erased key is never recreated. */
  async issue(accountId: string, at: Date): Promise<SealKey> {
    await this.tx
      .insert(schema.accountDataKeys)
      .values({
        id: accountId,
        tenantId: this.tenantId,
        material: randomBytes(32).toString('base64url'),
        createdAt: at,
      })
      .onConflictDoNothing()
    this.#known.delete(accountId)
    const key = await this.keyOf(accountId)
    if (!key) throw new Error('Account data key was erased')
    return key
  }

  async required(accountId: string): Promise<SealKey> {
    const key = await this.keyOf(accountId)
    if (!key) throw new Error('Account data key is unavailable')
    return key
  }

  /** Open a sealed value, or `null` when the account's key is gone. */
  text(key: SealKey | null, record: string, field: string, sealed: string | null): string | null {
    return key === null || sealed === null ? null : this.sealer.open(key, record, field, sealed)
  }
}

const subjectOfRow = (row: { subjectType: string; subjectId: string }): Subject => ({
  type: row.subjectType as SubjectType,
  id: row.subjectId,
})

export async function mapActivity(
  keys: KeyRing,
  row: typeof schema.activities.$inferSelect,
): Promise<Activity> {
  const key = await keys.keyOf(row.accountId)
  const record = `activity:${row.id}`
  const summary = keys.text(key, record, 'summary', row.summaryCiphertext)
  return Activity.rehydrate(
    {
      tenantId: row.tenantId,
      accountId: row.accountId,
      subject: subjectOfRow(row),
      kind: row.kind as ActivityKind,
      occurredAt: row.occurredAt,
      title: restored(
        RecordText.line(
          keys.text(key, record, 'title', row.titleCiphertext) ?? ERASED_TEXT,
          '/title',
        ),
      ),
      summary:
        summary === null ? null : restored(RecordText.long(summary, '/summary', MAX_SUMMARY)),
      contactIds: row.contactIds,
      recordedBy: row.recordedBy,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

export async function mapTask(keys: KeyRing, row: typeof schema.tasks.$inferSelect): Promise<Task> {
  const key = await keys.keyOf(row.accountId)
  const title = keys.text(key, `task:${row.id}`, 'title', row.titleCiphertext) ?? ERASED_TEXT
  return Task.rehydrate(
    {
      tenantId: row.tenantId,
      accountId: row.accountId,
      subject: subjectOfRow(row),
      title: restored(RecordText.line(title, '/title')),
      assigneeId: row.assigneeId,
      dueAt: row.dueAt,
      remindAt: row.remindAt,
      remindedAt: row.remindedAt,
      status: row.status as TaskStatus,
      createdBy: row.createdBy,
      closedBy: row.closedBy,
      closedAt: row.closedAt,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

export async function mapNote(
  keys: KeyRing,
  row: typeof schema.notes.$inferSelect,
  revisions: readonly (typeof schema.noteRevisions.$inferSelect)[],
): Promise<Note> {
  const key = await keys.keyOf(row.accountId)
  return Note.rehydrate(
    {
      tenantId: row.tenantId,
      accountId: row.accountId,
      subject: subjectOfRow(row),
      revisions: [...revisions]
        .sort((a, b) => a.revision - b.revision)
        .map((revision) => ({
          revision: revision.revision,
          body: restored(
            RecordText.long(
              keys.text(
                key,
                noteRecord(row.id, revision.revision),
                'body',
                revision.bodyCiphertext,
              ) ?? ERASED_TEXT,
              '/body',
              MAX_NOTE,
            ),
          ),
          author: revision.author,
          writtenAt: revision.writtenAt,
        })),
      createdAt: row.createdAt,
    },
    new UniqueEntityID(row.id),
  )
}

export const noteRecord = (noteId: string, revision: number) => `note:${noteId}:${revision}`

type Flush = (aggregate: { pullDomainEvents(): readonly DomainEvent[] }) => Promise<void>

export interface RecordRepositories {
  readonly activities: ActivitiesRepository
  readonly tasks: TasksRepository
  readonly notes: NotesRepository
}

/** The repositories for activities, tasks and notes inside one tenant transaction. */
export function recordRepositories(
  tx: Transaction,
  tenantId: string,
  keys: KeyRing,
  flush: Flush,
  assertTenant: (owner: { belongsTo(tenantId: string): boolean }) => void,
): RecordRepositories {
  const sealer = keys.sealer

  const activityText = (key: SealKey, activity: Activity) => {
    const snapshot = activity.toSnapshot()
    const record = `activity:${snapshot.id}`
    return {
      kind: snapshot.kind,
      occurredAt: snapshot.occurredAt,
      titleCiphertext: sealer.seal(key, record, 'title', snapshot.title),
      summaryCiphertext:
        snapshot.summary === null ? null : sealer.seal(key, record, 'summary', snapshot.summary),
      contactIds: [...snapshot.contactIds],
      version: snapshot.version,
      updatedAt: snapshot.updatedAt,
    }
  }

  const taskTitle = (key: SealKey, task: Task) =>
    sealer.seal(key, `task:${task.id.toString()}`, 'title', task.toSnapshot().title)

  const taskState = (task: Task) => {
    const snapshot = task.toSnapshot()
    return {
      assigneeId: snapshot.assigneeId,
      dueAt: snapshot.dueAt,
      remindAt: snapshot.remindAt,
      remindedAt: snapshot.remindedAt,
      status: snapshot.status,
      closedBy: snapshot.closedBy,
      closedAt: snapshot.closedAt,
      version: snapshot.version,
      updatedAt: snapshot.updatedAt,
    }
  }

  const appendRevisions = async (key: SealKey, note: Note) => {
    const revisions = note.pullNewRevisions()
    if (!revisions.length) return
    const noteId = note.id.toString()
    await tx.insert(schema.noteRevisions).values(
      revisions.map((revision) => ({
        tenantId,
        noteId,
        revision: revision.revision,
        bodyCiphertext: sealer.seal(
          key,
          noteRecord(noteId, revision.revision),
          'body',
          revision.body.value,
        ),
        author: revision.author,
        writtenAt: revision.writtenAt,
      })),
    )
  }

  return {
    activities: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.activities)
          .where(eq(schema.activities.id, id))
          .limit(1)
          .for('update')
        return row ? mapActivity(keys, row) : null
      },
      create: async (activity) => {
        assertTenant(activity)
        const snapshot = activity.toSnapshot()
        const key = await keys.issue(snapshot.accountId, snapshot.createdAt)
        await tx.insert(schema.activities).values({
          id: snapshot.id,
          tenantId,
          accountId: snapshot.accountId,
          subjectType: snapshot.subject.type,
          subjectId: snapshot.subject.id,
          recordedBy: snapshot.recordedBy,
          createdAt: snapshot.createdAt,
          ...activityText(key, activity),
        })
        await flush(activity)
      },
      save: async (activity) => {
        assertTenant(activity)
        const key = await keys.required(activity.accountId)
        await tx
          .update(schema.activities)
          .set(activityText(key, activity))
          .where(eq(schema.activities.id, activity.id.toString()))
        await flush(activity)
      },
    },
    tasks: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.tasks)
          .where(eq(schema.tasks.id, id))
          .limit(1)
          .for('update')
        return row ? mapTask(keys, row) : null
      },
      findOpenOf: async (accountId) => {
        const rows = await tx
          .select()
          .from(schema.tasks)
          .where(and(eq(schema.tasks.accountId, accountId), eq(schema.tasks.status, 'open')))
          .for('update')
        return Promise.all(rows.map((row) => mapTask(keys, row)))
      },
      claimDueReminders: async (now, limit) => {
        const rows = await tx
          .select()
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.status, 'open'),
              isNull(schema.tasks.remindedAt),
              isNotNull(schema.tasks.remindAt),
              lte(schema.tasks.remindAt, now),
            ),
          )
          .orderBy(asc(schema.tasks.remindAt), asc(schema.tasks.id))
          .limit(limit)
          .for('update', { skipLocked: true })
        return Promise.all(rows.map((row) => mapTask(keys, row)))
      },
      create: async (task) => {
        assertTenant(task)
        const snapshot = task.toSnapshot()
        const key = await keys.issue(snapshot.accountId, snapshot.createdAt)
        await tx.insert(schema.tasks).values({
          id: snapshot.id,
          tenantId,
          accountId: snapshot.accountId,
          subjectType: snapshot.subject.type,
          subjectId: snapshot.subject.id,
          createdBy: snapshot.createdBy,
          createdAt: snapshot.createdAt,
          titleCiphertext: taskTitle(key, task),
          ...taskState(task),
        })
        await flush(task)
      },
      save: async (task) => {
        assertTenant(task)
        const snapshot = task.toSnapshot()
        const key = await keys.keyOf(snapshot.accountId)
        // An erased account's task can still be cancelled; its title stays unreadable.
        const title = key ? { titleCiphertext: taskTitle(key, task) } : {}
        await tx
          .update(schema.tasks)
          .set({ ...title, ...taskState(task) })
          .where(eq(schema.tasks.id, snapshot.id))
        await flush(task)
      },
    },
    notes: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.notes)
          .where(eq(schema.notes.id, id))
          .limit(1)
          .for('update')
        if (!row) return null
        const revisions = await tx
          .select()
          .from(schema.noteRevisions)
          .where(eq(schema.noteRevisions.noteId, id))
        return mapNote(keys, row, revisions)
      },
      create: async (note) => {
        assertTenant(note)
        const snapshot = note.toSnapshot()
        const key = await keys.issue(snapshot.accountId, snapshot.createdAt)
        await tx.insert(schema.notes).values({
          id: snapshot.id,
          tenantId,
          accountId: snapshot.accountId,
          subjectType: snapshot.subject.type,
          subjectId: snapshot.subject.id,
          currentRevision: note.current.revision,
          createdAt: snapshot.createdAt,
          updatedAt: note.current.writtenAt,
        })
        await appendRevisions(key, note)
        await flush(note)
      },
      save: async (note) => {
        assertTenant(note)
        const key = await keys.required(note.accountId)
        await appendRevisions(key, note)
        await tx
          .update(schema.notes)
          .set({ currentRevision: note.current.revision, updatedAt: note.current.writtenAt })
          .where(eq(schema.notes.id, note.id.toString()))
        await flush(note)
      },
    },
  }
}
