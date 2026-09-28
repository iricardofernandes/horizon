import { createHash } from 'node:crypto'
import type { AttachmentDeletionReason, AttachmentRequest } from '@horizon/contracts'
import { uuidv7 } from 'uuidv7'
import { canonicalJson } from '@/core/audit/canonical-json'
import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import {
  type Attachment,
  acceptsBytes,
  deleted,
  type Owner,
  purged,
  quarantined,
  released,
  slotOf,
  stored,
} from '@/domain/attachment'
import { matchesType } from '@/domain/content'
import type { RecordReference } from '@/domain/records'
import type {
  Clock,
  Envelope,
  FilesScope,
  FilesStore,
  ObjectStore,
  OutgoingEvent,
  Scanner,
} from './ports'
import { objectKeyOf } from './ports'

export interface CommandContext {
  readonly tenantId: string
  readonly actor: string
  readonly requestId: string | null
}

export interface IdempotentContext extends CommandContext {
  readonly idempotencyKey: string
}

export interface AttachmentsOptions {
  /** How long a scan that could not answer waits before it is tried again. */
  readonly scanRetryMs: number
}

type Failure = InvalidInputError | ConflictError | ResourceNotFoundError

const notFound = () => new ResourceNotFoundError('Attachment was not found')

/** The owner whose erasure shreds the file: the party it is about, or its uploader. */
export function ownerOf(input: AttachmentRequest, actor: string): Owner {
  if (input.module === 'parties') return { type: 'party', id: input.recordId }
  if (input.ownerPartyId) return { type: 'party', id: input.ownerPartyId }
  return { type: 'user', id: actor }
}

/** The facts published about an attachment; never its name (ADR 0060). */
export function eventOf(attachment: Attachment, now: Date): OutgoingEvent {
  const reference = {
    attachmentId: attachment.id,
    module: attachment.module,
    recordType: attachment.recordType,
    recordId: attachment.recordId,
  }
  switch (attachment.status) {
    case 'available':
      return {
        eventType: 'files.attachment.available',
        occurredAt: now,
        payload: { ...reference, contentType: attachment.contentType, size: attachment.size },
      }
    case 'quarantined':
      return {
        eventType: 'files.attachment.quarantined',
        occurredAt: now,
        payload: { ...reference, uploadedBy: attachment.uploadedBy },
      }
    case 'deleted':
      return {
        eventType: 'files.attachment.deleted',
        occurredAt: now,
        payload: { ...reference, reason: attachment.deletionReason },
      }
    default:
      throw new Error(`No event for an attachment that is ${attachment.status}`)
  }
}

/**
 * Attachments (ADR 0060): a slot, its bytes, their scan, then served, quarantined or
 * ended. Each step writes only if the row is still where the step found it.
 */
export class Attachments {
  constructor(
    private readonly store: FilesStore,
    private readonly objects: ObjectStore,
    private readonly scanner: Scanner,
    private readonly envelope: Envelope,
    private readonly clock: Clock,
    private readonly options: AttachmentsOptions,
  ) {}

  /** A slot to upload to. The same key and body answer the same slot again. */
  request(
    context: IdempotentContext,
    input: AttachmentRequest,
  ): Promise<Either<Failure, Attachment>> {
    const fingerprint = createHash('sha256').update(canonicalJson(input)).digest('hex')
    const now = this.clock.now()
    return this.store.inTenant(context.tenantId, async (scope) => {
      const previous = await scope.attachments.findByKey(context.idempotencyKey)
      if (previous)
        return previous.fingerprint === fingerprint && previous.uploadedBy === context.actor
          ? right(previous)
          : left(new ConflictError('this Idempotency-Key was already used for a different request'))
      const owner = ownerOf(input, context.actor)
      const key = await this.ownerKey(scope, context.tenantId, owner, now)
      if (!key) return left(new ConflictError('The owner of this record was erased'))
      const attachment = slotOf({
        id: uuidv7(),
        record: input,
        fileName: input.fileName,
        contentType: input.contentType,
        size: input.size,
        owner,
        idempotencyKey: context.idempotencyKey,
        fingerprint,
        uploadedBy: context.actor,
        now,
      })
      await scope.attachments.insert(attachment)
      await scope.audit.append({
        actor: context.actor,
        action: 'attachment.requested',
        attachmentId: attachment.id,
        occurredAt: now,
        requestId: context.requestId,
        details: { ...recordOf(attachment), contentType: input.contentType, size: input.size },
      })
      return right(attachment)
    })
  }

  private async ownerKey(
    scope: FilesScope,
    tenantId: string,
    owner: Owner,
    now: Date,
  ): Promise<string | null> {
    const existing = await scope.ownerKeys.find(owner)
    if (existing) return existing.wrappedKey
    const created = await scope.ownerKeys.create(
      owner,
      this.envelope.newOwnerKey(tenantId, owner),
      now,
    )
    return created.wrappedKey
  }

  /**
   * The bytes of a slot, through its signed link: checked against the declaration,
   * encrypted, stored, then scanned at once. A scan without an answer is left to the worker.
   */
  async receive(
    tenantId: string,
    id: string,
    upload: { contentType: string; bytes: Buffer },
  ): Promise<Either<Failure, Attachment>> {
    const now = this.clock.now()
    const prepared = await this.store.inTenant(tenantId, async (scope) => {
      const attachment = await scope.attachments.find(id)
      if (!attachment) return left<Failure, never>(notFound())
      if (!acceptsBytes(attachment, now))
        return left<Failure, never>(new ConflictError(`The attachment is ${attachment.status}`))
      const refusal = refusalOf(attachment, upload)
      if (refusal) return left<Failure, never>(refusal)
      const key = await scope.ownerKeys.find(attachment.owner)
      if (!key?.wrappedKey)
        return left<Failure, never>(new ConflictError('The owner of this record was erased'))
      return right<Failure, { attachment: Attachment; ownerKey: string }>({
        attachment,
        ownerKey: key.wrappedKey,
      })
    })
    if (prepared.isLeft()) return left(prepared.value)
    const { attachment, ownerKey } = prepared.value
    const objectKey = objectKeyOf(tenantId, id)
    const sealed = this.envelope.seal(
      ownerKey,
      { tenantId, attachmentId: id, owner: attachment.owner },
      upload.bytes,
    )
    await this.objects.put(objectKey, sealed.object)
    const next = stored(attachment, {
      sha256: createHash('sha256').update(upload.bytes).digest('hex'),
      wrappedDataKey: sealed.wrappedDataKey,
      objectKey,
      now,
      retryMs: this.options.scanRetryMs,
    })
    const moved = await this.store.inTenant(tenantId, (scope) =>
      scope.attachments.replace(attachment, next),
    )
    if (!moved) return this.current(tenantId, id)
    return right(await this.scan(tenantId, next, upload.bytes))
  }

  private async current(tenantId: string, id: string): Promise<Either<Failure, Attachment>> {
    const attachment = await this.store.inTenant(tenantId, (scope) => scope.attachments.find(id))
    return attachment ? right(attachment) : left(notFound())
  }

  /** Asks the scanner; a failure leaves the file scanning, never released (ADR 0060). */
  private async scan(tenantId: string, attachment: Attachment, bytes: Buffer): Promise<Attachment> {
    let verdict: Awaited<ReturnType<Scanner['scan']>>
    try {
      verdict = await this.scanner.scan(bytes)
    } catch {
      return attachment
    }
    const now = this.clock.now()
    const next = verdict.clean
      ? released(attachment, now)
      : quarantined(attachment, verdict.finding, now)
    const moved = await this.store.inTenant(tenantId, async (scope) => {
      if (!(await scope.attachments.replace(attachment, next))) return false
      await scope.outbox.append(eventOf(next, now))
      return true
    })
    if (!moved) return attachment
    return next.status === 'quarantined' ? this.purge(tenantId, next, 'quarantined') : next
  }

  /** Removes stored bytes and logs it; the worker does it again if this fails. */
  async purge(
    tenantId: string,
    attachment: Attachment,
    reason: AttachmentDeletionReason,
  ): Promise<Attachment> {
    if (!attachment.objectKey) return attachment
    try {
      await this.objects.remove(attachment.objectKey)
    } catch {
      return attachment
    }
    return this.store.inTenant(tenantId, async (scope) => {
      const next = purged(attachment)
      if (!(await scope.attachments.replace(attachment, next))) return attachment
      await scope.removals.append({
        attachmentId: attachment.id,
        ...recordOf(attachment),
        reason,
        bytes: attachment.size,
        removedAt: this.clock.now(),
      })
      return next
    })
  }

  list(tenantId: string, record: RecordReference): Promise<Attachment[]> {
    return this.store.inTenant(tenantId, (scope) => scope.attachments.ofRecord(record))
  }

  find(tenantId: string, id: string): Promise<Attachment | null> {
    return this.store.inTenant(tenantId, (scope) => scope.attachments.find(id))
  }

  /** Records who took a download link; only an available file has one. */
  issueLink(context: CommandContext, id: string): Promise<Either<Failure, Attachment>> {
    const now = this.clock.now()
    return this.store.inTenant(context.tenantId, async (scope) => {
      const attachment = await scope.attachments.find(id)
      if (!attachment) return left(notFound())
      if (attachment.status !== 'available')
        return left(new ConflictError(`The attachment is ${attachment.status}`))
      await scope.audit.append({
        actor: context.actor,
        action: 'attachment.link-issued',
        attachmentId: id,
        occurredAt: now,
        requestId: context.requestId,
        details: recordOf(attachment),
      })
      return right(attachment)
    })
  }

  /** The decrypted bytes of a file that is still available, or null. */
  async content(
    tenantId: string,
    id: string,
  ): Promise<{ attachment: Attachment; bytes: Buffer } | null> {
    const attachment = await this.find(tenantId, id)
    if (attachment?.status !== 'available') return null
    const bytes = await this.plaintextOf(tenantId, attachment)
    return bytes ? { attachment, bytes } : null
  }

  /** A person removes a file; its bytes go now, or at the worker's next pass. */
  async remove(context: CommandContext, id: string): Promise<Either<Failure, Attachment>> {
    const now = this.clock.now()
    const outcome = await this.store.inTenant(context.tenantId, async (scope) => {
      const attachment = await scope.attachments.find(id)
      if (!attachment || attachment.status === 'deleted')
        return left<Failure, Attachment>(notFound())
      const next = deleted(attachment, 'removed', now)
      if (!(await scope.attachments.replace(attachment, next)))
        return left<Failure, Attachment>(new ConflictError('The attachment changed; try again'))
      await scope.outbox.append(eventOf(next, now))
      await scope.audit.append({
        actor: context.actor,
        action: 'attachment.deleted',
        attachmentId: id,
        occurredAt: now,
        requestId: context.requestId,
        details: recordOf(attachment),
      })
      return right<Failure, Attachment>(next)
    })
    if (outcome.isLeft()) return outcome
    return right(await this.purge(context.tenantId, outcome.value, 'removed'))
  }

  /** Scans a stored file again, for the worker. */
  async rescan(tenantId: string, attachment: Attachment): Promise<Attachment> {
    const bytes = await this.plaintextOf(tenantId, attachment)
    if (!bytes) return attachment
    return this.scan(tenantId, attachment, bytes)
  }

  /** Null when there are no bytes, or no key left to open them. */
  private async plaintextOf(tenantId: string, attachment: Attachment): Promise<Buffer | null> {
    if (!attachment.objectKey || !attachment.wrappedDataKey) return null
    const key = await this.store.inTenant(tenantId, (scope) =>
      scope.ownerKeys.find(attachment.owner),
    )
    if (!key?.wrappedKey) return null
    const object = await this.objects.get(attachment.objectKey)
    return this.envelope.open(
      key.wrappedKey,
      { tenantId, attachmentId: attachment.id, owner: attachment.owner },
      attachment.wrappedDataKey,
      object,
    )
  }
}

export function recordOf(attachment: RecordReference): RecordReference & Record<string, unknown> {
  return {
    module: attachment.module,
    recordType: attachment.recordType,
    recordId: attachment.recordId,
  }
}

/** Why the bytes do not match their slot, if they do not. */
function refusalOf(
  attachment: Attachment,
  upload: { contentType: string; bytes: Buffer },
): InvalidInputError | null {
  if (upload.bytes.length !== attachment.size)
    return new InvalidInputError(
      'body',
      `The file has ${upload.bytes.length} bytes; ${attachment.size} were declared`,
    )
  if (upload.contentType !== attachment.contentType)
    return new InvalidInputError(
      'content-type',
      `The file was declared as ${attachment.contentType}`,
    )
  if (!matchesType(attachment.contentType, upload.bytes))
    return new InvalidInputError('body', `The file is not a ${attachment.contentType}`)
  return null
}
