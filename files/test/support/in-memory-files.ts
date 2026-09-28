import type {
  CipherContext,
  Envelope,
  FilesScope,
  FilesStore,
  ObjectStore,
  OutgoingEvent,
  OwnerKey,
  Removal,
  Scanner,
  ScanVerdict,
} from '@/application/ports'
import type { Attachment, Owner } from '@/domain/attachment'

const ownerId = (owner: Owner) => `${owner.type}:${owner.id}`

interface TenantState {
  attachments: Map<string, Attachment>
  ownerKeys: Map<string, OwnerKey>
  removals: Removal[]
  audit: { action: string; attachmentId: string; actor: string }[]
  outbox: OutgoingEvent[]
  inbox: Set<string>
}

/** A tenant-scoped fake of the store: one tenant never sees another's rows (ADR 0014). */
export class InMemoryFilesStore implements FilesStore {
  readonly tenants = new Map<string, TenantState>()

  state(tenantId: string): TenantState {
    let state = this.tenants.get(tenantId)
    if (!state) {
      state = {
        attachments: new Map(),
        ownerKeys: new Map(),
        removals: [],
        audit: [],
        outbox: [],
        inbox: new Set(),
      }
      this.tenants.set(tenantId, state)
    }
    return state
  }

  async inTenant<T>(tenantId: string, work: (scope: FilesScope) => Promise<T>): Promise<T> {
    return work(this.scope(this.state(tenantId)))
  }

  private scope(state: TenantState): FilesScope {
    return {
      attachments: {
        insert: async (attachment) => {
          state.attachments.set(attachment.id, attachment)
        },
        find: async (id) => state.attachments.get(id) ?? null,
        findByKey: async (key) =>
          [...state.attachments.values()].find((row) => row.idempotencyKey === key) ?? null,
        replace: async (expected, next) => {
          const current = state.attachments.get(expected.id)
          if (current !== expected && JSON.stringify(current) !== JSON.stringify(expected))
            return false
          state.attachments.set(next.id, next)
          return true
        },
        ofRecord: async (record) =>
          [...state.attachments.values()].filter(
            (row) =>
              row.module === record.module &&
              row.recordType === record.recordType &&
              row.recordId === record.recordId &&
              ['scanning', 'available', 'quarantined'].includes(row.status),
          ),
        ofOwner: async (owner) =>
          [...state.attachments.values()].filter(
            (row) => ownerId(row.owner) === ownerId(owner) && row.status !== 'deleted',
          ),
        claimDue: async (now, until, limit) => {
          const due = [...state.attachments.values()]
            .filter((row) => row.dueAt && row.dueAt.getTime() <= now.getTime())
            .slice(0, limit)
            .map((row) => ({ ...row, dueAt: until }))
          for (const row of due) state.attachments.set(row.id, row)
          return due
        },
      },
      ownerKeys: {
        find: async (owner) => state.ownerKeys.get(ownerId(owner)) ?? null,
        create: async (owner, wrappedKey) => {
          const existing = state.ownerKeys.get(ownerId(owner))
          if (existing) return existing
          const created = { owner, wrappedKey, erasedAt: null }
          state.ownerKeys.set(ownerId(owner), created)
          return created
        },
        shred: async (owner, now) => {
          state.ownerKeys.set(ownerId(owner), { owner, wrappedKey: null, erasedAt: now })
        },
      },
      removals: {
        append: async (removal) => {
          state.removals.push(removal)
        },
      },
      audit: {
        append: async (record) => {
          state.audit.push(record)
        },
      },
      outbox: {
        append: async (event) => {
          state.outbox.push(event)
        },
      },
      inbox: {
        claim: async (source, eventId) => {
          const key = `${source}:${eventId}`
          if (state.inbox.has(key)) return false
          state.inbox.add(key)
          return true
        },
      },
    }
  }
}

export class InMemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>()
  failRemoval = false

  async put(key: string, bytes: Buffer) {
    this.objects.set(key, bytes)
  }

  async get(key: string) {
    const bytes = this.objects.get(key)
    if (!bytes) throw new Error('No such object')
    return bytes
  }

  async remove(key: string) {
    if (this.failRemoval) throw new Error('Storage is down')
    this.objects.delete(key)
  }
}

/** A scanner that answers what it is told, or fails. */
export class ScriptedScanner implements Scanner {
  answer: ScanVerdict | 'fail' = { clean: true }
  calls = 0

  async scan(): Promise<ScanVerdict> {
    this.calls += 1
    if (this.answer === 'fail') throw new Error('Scanner unreachable')
    return this.answer
  }
}

/**
 * A transparent envelope: the object names its context, so a test sees the bytes are
 * stored sealed and that they open only with the same owner key and context.
 */
export class FakeEnvelope implements Envelope {
  private counter = 0

  newOwnerKey(tenantId: string, owner: Owner) {
    this.counter += 1
    return `owner-key-${this.counter}:${tenantId}:${ownerId(owner)}`
  }

  seal(wrappedOwnerKey: string, context: CipherContext, plaintext: Buffer) {
    return {
      object: Buffer.concat([Buffer.from(`sealed:${context.attachmentId}:`), plaintext]),
      wrappedDataKey: `data-key:${wrappedOwnerKey}`,
    }
  }

  open(wrappedOwnerKey: string, context: CipherContext, wrappedDataKey: string, object: Buffer) {
    const prefix = Buffer.from(`sealed:${context.attachmentId}:`)
    if (
      wrappedDataKey !== `data-key:${wrappedOwnerKey}` ||
      !object.subarray(0, prefix.length).equals(prefix)
    )
      throw new Error('Does not open')
    return object.subarray(prefix.length)
  }
}

export class ManualClock {
  constructor(public current = new Date('2026-09-28T12:00:00.000Z')) {}

  now() {
    return this.current
  }

  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms)
  }
}
