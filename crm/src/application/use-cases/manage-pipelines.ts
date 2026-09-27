import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { ListEntry } from '@/domain/entities/list-entry'
import { Pipeline } from '@/domain/entities/pipeline'
import { LabelName, type ListKind, Probability } from '@/domain/value-objects/crm-values'
import type { Clock } from '../ports/clock'
import type { CrmScope, CrmUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext, type IdempotentContext, once } from './commands'

type Failure = InvalidInputError | ConflictError | ResourceNotFoundError

/** An absent field stays as it is; a present one must be valid. */
function optional<I, T>(
  value: I | undefined,
  create: (present: I) => Either<InvalidInputError, T>,
): Either<InvalidInputError, T | undefined> {
  return value === undefined ? right(undefined) : create(value)
}

export interface StageInput {
  readonly name: string
  readonly probabilityBps: number
}

function stageOf(
  input: StageInput,
): Either<InvalidInputError, { name: LabelName; probability: Probability }> {
  const name = LabelName.create(input.name)
  if (name.isLeft()) return left(name.value)
  const probability = Probability.create(input.probabilityBps)
  if (probability.isLeft()) return left(probability.value)
  return right({ name: name.value, probability: probability.value })
}

/** Workspace settings: who may change them is decided at the boundary (`configure`). */
export class CreatePipelineUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly context: IdempotentContext
    readonly name: string
    readonly stages: readonly StageInput[]
  }): Promise<Either<Failure, { pipelineId: string }>> {
    const name = LabelName.create(request.name)
    if (name.isLeft()) return left(name.value)
    const stages: { name: LabelName; probability: Probability }[] = []
    for (const input of request.stages) {
      const stage = stageOf(input)
      if (stage.isLeft()) return left(stage.value)
      stages.push(stage.value)
    }
    const { context } = request
    // The fingerprint is what was asked, never who asked or the request id (Phase 50).
    const { context: _, ...asked } = request
    return once(this.unitOfWork, context, 'pipeline.create', asked, async (scope) => {
      const now = this.clock.now()
      const pipeline = Pipeline.create({
        tenantId: context.tenantId,
        name: name.value,
        stages,
        now,
      })
      if (pipeline.isLeft()) return left(pipeline.value)
      await scope.pipelines.create(pipeline.value)
      const pipelineId = pipeline.value.id.toString()
      await audit(scope, context, {
        action: 'pipeline.created',
        subjectType: 'pipeline',
        subjectId: pipelineId,
        occurredAt: now,
        details: { stages: stages.length },
      })
      return right({ pipelineId })
    })
  }
}

export type PipelineChange =
  | { readonly kind: 'rename'; readonly name: string }
  | { readonly kind: 'add-stage'; readonly stage: StageInput }
  | {
      readonly kind: 'revise-stage'
      readonly stageId: string
      readonly name?: string | undefined
      readonly probabilityBps?: number | undefined
      readonly archived?: boolean | undefined
    }
  | { readonly kind: 'reorder'; readonly stageIds: readonly string[] }
  | { readonly kind: 'archive'; readonly archived: boolean }

type Decision = Either<
  Failure,
  { action: string; details: Record<string, unknown>; stageId?: string }
>

function rename(pipeline: Pipeline, name: string, now: Date): Decision {
  const label = LabelName.create(name)
  if (label.isLeft()) return left(label.value)
  pipeline.rename(label.value, now)
  return right({ action: 'pipeline.renamed', details: {} })
}

function addStage(pipeline: Pipeline, input: StageInput, now: Date): Decision {
  const stage = stageOf(input)
  if (stage.isLeft()) return left(stage.value)
  const added = pipeline.addStage(stage.value.name, stage.value.probability, now)
  if (added.isLeft()) return left(added.value)
  return right({
    action: 'pipeline.stage-added',
    details: { stageId: added.value, probabilityBps: stage.value.probability.bps },
    stageId: added.value,
  })
}

function reviseStage(
  pipeline: Pipeline,
  change: Extract<PipelineChange, { kind: 'revise-stage' }>,
  now: Date,
): Decision {
  const name = optional(change.name, (value) => LabelName.create(value))
  if (name.isLeft()) return left(name.value)
  const probability = optional(change.probabilityBps, (value) => Probability.create(value))
  if (probability.isLeft()) return left(probability.value)
  const revised = pipeline.reviseStage(
    change.stageId,
    { name: name.value, probability: probability.value, archived: change.archived },
    now,
  )
  if (revised.isLeft()) return left(revised.value)
  const { kind: _, name: __, ...details } = change
  return right({ action: 'pipeline.stage-revised', details })
}

/** Decide one change on a loaded pipeline; returns the audit action and any new stage id. */
function apply(pipeline: Pipeline, change: PipelineChange, now: Date): Decision {
  switch (change.kind) {
    case 'rename':
      return rename(pipeline, change.name, now)
    case 'add-stage':
      return addStage(pipeline, change.stage, now)
    case 'revise-stage':
      return reviseStage(pipeline, change, now)
    case 'reorder': {
      const reordered = pipeline.reorder(change.stageIds, now)
      if (reordered.isLeft()) return left(reordered.value)
      return right({
        action: 'pipeline.stages-reordered',
        details: { stageIds: [...change.stageIds] },
      })
    }
    case 'archive': {
      const archived = pipeline.setArchived(change.archived, now)
      if (archived.isLeft()) return left(archived.value)
      return right({
        action: change.archived ? 'pipeline.archived' : 'pipeline.restored',
        details: {},
      })
    }
  }
}

export class ChangePipelineUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    readonly context: CommandContext
    readonly pipelineId: string
    readonly change: PipelineChange
  }): Promise<Either<Failure, { stageId?: string }>> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const pipeline = await scope.pipelines.findById(request.pipelineId)
      if (!pipeline) return left(new ResourceNotFoundError('pipeline was not found'))
      const now = this.clock.now()
      const outcome = apply(pipeline, request.change, now)
      if (outcome.isLeft()) return left(outcome.value)
      await scope.pipelines.save(pipeline)
      await audit(scope, context, {
        action: outcome.value.action,
        subjectType: 'pipeline',
        subjectId: request.pipelineId,
        occurredAt: now,
        details: outcome.value.details,
      })
      return right(outcome.value.stageId === undefined ? {} : { stageId: outcome.value.stageId })
    })
  }
}

async function nameTaken(scope: CrmScope, kind: ListKind, name: LabelName, except?: string) {
  const holder = await scope.lists.findActiveByName(kind, name.value)
  return holder !== null && holder.id.toString() !== except
}

/**
 * Archive, restore or rename an entry. A restored or renamed entry must not collide with
 * an active one: the name is what a person picks it by.
 */
async function changeEntry(
  scope: CrmScope,
  entry: ListEntry,
  name: LabelName | undefined,
  archived: boolean | undefined,
  now: Date,
): Promise<Either<Failure, void>> {
  // Checked before anything changes, so the entry itself never counts as the holder.
  const checked = name ?? (archived === false ? entry.name : undefined)
  if (checked && (await nameTaken(scope, entry.kind, checked, entry.id.toString())))
    return left(new ConflictError(`an active ${entry.kind} already has this name`))
  if (archived !== undefined) {
    const changed = entry.setArchived(archived, now)
    if (changed.isLeft()) return left(changed.value)
  }
  if (name) entry.rename(name, now)
  return right(undefined)
}

/** A source or a loss reason. Names are unique among the active entries of each list. */
export class CreateListEntryUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly context: IdempotentContext
    readonly kind: ListKind
    readonly name: string
  }): Promise<Either<Failure, { entryId: string }>> {
    const name = LabelName.create(request.name)
    if (name.isLeft()) return left(name.value)
    const { context } = request
    const { context: _, ...asked } = request
    return once(this.unitOfWork, context, `${request.kind}.create`, asked, async (scope) => {
      if (await nameTaken(scope, request.kind, name.value))
        return left(new ConflictError(`an active ${request.kind} already has this name`))
      const now = this.clock.now()
      const entry = ListEntry.create(
        { tenantId: context.tenantId, kind: request.kind, name: name.value, now },
        new UniqueEntityID(),
      )
      await scope.lists.create(entry)
      await audit(scope, context, {
        action: `${request.kind}.created`,
        subjectType: 'list-entry',
        subjectId: entry.id.toString(),
        occurredAt: now,
        details: { kind: request.kind },
      })
      return right({ entryId: entry.id.toString() })
    })
  }
}

export class ChangeListEntryUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly context: CommandContext
    readonly kind: ListKind
    readonly entryId: string
    readonly name?: string | undefined
    readonly archived?: boolean | undefined
  }): Promise<Either<Failure, void>> {
    const name = optional(request.name, (value) => LabelName.create(value))
    if (name.isLeft()) return left(name.value)
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const entry = await scope.lists.findById(request.entryId)
      if (!entry || entry.kind !== request.kind)
        return left(new ResourceNotFoundError(`${request.kind} was not found`))
      const now = this.clock.now()
      const changed = await changeEntry(scope, entry, name.value, request.archived, now)
      if (changed.isLeft()) return changed
      await scope.lists.save(entry)
      await audit(scope, context, {
        action: `${request.kind}.changed`,
        subjectType: 'list-entry',
        subjectId: request.entryId,
        occurredAt: now,
        details: {
          ...(name.value ? { renamed: true } : {}),
          ...(request.archived === undefined ? {} : { archived: request.archived }),
        },
      })
      return right(undefined)
    })
  }
}
