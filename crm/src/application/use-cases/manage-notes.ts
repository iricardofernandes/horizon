import { type Either, left, right } from '@/core/either'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { Note } from '@/domain/entities/note'
import { MAX_NOTE, RecordText } from '@/domain/value-objects/record-values'
import type { Clock } from '../ports/clock'
import type { CrmUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext, type IdempotentContext, once } from './commands'
import { accountOfSubject, type Failure, liveAccount, type SubjectInput } from './record-subjects'

/** Write a note about an account, a contact or an opportunity. Retried, it writes it once. */
export class WriteNoteUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly context: IdempotentContext
    readonly subject: SubjectInput
    readonly body: string
  }): Promise<Either<Failure, { noteId: string; revision: number }>> {
    const body = RecordText.long(request.body, '/body', MAX_NOTE)
    if (body.isLeft()) return left(body.value)
    const { context } = request
    const { context: _, ...asked } = request
    return once(this.unitOfWork, context, 'note.write', asked, async (scope) => {
      const target = await accountOfSubject(scope, request.subject)
      if (target.isLeft()) return left(target.value)
      const now = this.clock.now()
      const accountId = target.value.account.id.toString()
      const note = Note.write({
        tenantId: context.tenantId,
        accountId,
        subject: target.value.subject,
        body: body.value,
        author: context.actor,
        now,
      })
      await scope.notes.create(note)
      const noteId = note.id.toString()
      await audit(scope, context, {
        action: 'note.written',
        subjectType: 'note',
        subjectId: noteId,
        occurredAt: now,
        details: { accountId, subject: target.value.subject },
      })
      return right({ noteId, revision: 1 })
    })
  }
}

/** Correct a note: a new revision, and the earlier text stays in its history. */
export class CorrectNoteUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly context: CommandContext
    readonly noteId: string
    readonly body: string
  }): Promise<Either<Failure, { revision: number }>> {
    const body = RecordText.long(request.body, '/body', MAX_NOTE)
    if (body.isLeft()) return left(body.value)
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const note = await scope.notes.findById(request.noteId)
      if (!note) return left(new ResourceNotFoundError('note was not found'))
      const account = await liveAccount(scope, note.accountId)
      if (account.isLeft()) return left(account.value)
      const now = this.clock.now()
      const revision = note.correct(body.value, context.actor, now)
      if (revision.isLeft()) return left(revision.value)
      await scope.notes.save(note)
      await audit(scope, context, {
        action: 'note.corrected',
        subjectType: 'note',
        subjectId: request.noteId,
        occurredAt: now,
        details: { revision: revision.value },
      })
      return right({ revision: revision.value })
    })
  }
}
