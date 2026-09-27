import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { LabelName, Probability } from '../value-objects/crm-values'

export interface Stage {
  readonly id: string
  readonly name: LabelName
  readonly probability: Probability
  readonly archived: boolean
}

interface PipelineProps {
  tenantId: string
  name: LabelName
  /** In the order an opportunity moves through them. */
  stages: Stage[]
  archived: boolean
  createdAt: Date
  updatedAt: Date
}

export interface PipelineSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly name: string
  readonly stages: readonly {
    readonly id: string
    readonly name: string
    readonly probabilityBps: number
    readonly archived: boolean
    readonly position: number
  }[]
  readonly archived: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

type Change = Either<ConflictError | InvalidInputError, void>

/**
 * A sequence of open stages an opportunity moves through, each with its chance of being
 * won. Won and lost are the opportunity's outcomes, not stages, so every pipeline has
 * exactly one of each and neither can be misconfigured (CRM plan, Phase 56).
 *
 * Nothing here is deleted: a stage in use is archived and keeps its opportunities and
 * their history; it only stops being a destination.
 */
export class Pipeline extends AggregateRoot<PipelineProps> {
  static create(
    props: {
      tenantId: string
      name: LabelName
      stages: readonly { name: LabelName; probability: Probability }[]
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<InvalidInputError, Pipeline> {
    if (!props.stages.length)
      return left(new InvalidInputError('/stages', 'a pipeline needs at least one stage'))
    const stages = props.stages.map((stage) => ({
      id: new UniqueEntityID().toString(),
      name: stage.name,
      probability: stage.probability,
      archived: false,
    }))
    const duplicate = duplicateName(stages)
    if (duplicate) return left(new InvalidInputError('/stages', `stage "${duplicate}" is repeated`))
    return right(
      new Pipeline(
        {
          tenantId: props.tenantId,
          name: props.name,
          stages,
          archived: false,
          createdAt: props.now,
          updatedAt: props.now,
        },
        id,
      ),
    )
  }

  static rehydrate(props: PipelineProps, id: UniqueEntityID): Pipeline {
    return new Pipeline(props, id)
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  stage(stageId: string): Stage | null {
    return this.props.stages.find((stage) => stage.id === stageId) ?? null
  }

  /** Where a new, moved or reopened opportunity may go. */
  destination(stageId: string): Either<ConflictError, Stage> {
    if (this.props.archived) return left(new ConflictError('the pipeline is archived'))
    const stage = this.stage(stageId)
    if (!stage) return left(new ConflictError('the stage is not part of this pipeline'))
    if (stage.archived) return left(new ConflictError('the stage is archived'))
    return right(stage)
  }

  rename(name: LabelName, now: Date): void {
    this.props.name = name
    this.props.updatedAt = now
  }

  addStage(
    name: LabelName,
    probability: Probability,
    now: Date,
  ): Either<InvalidInputError, string> {
    const stage = { id: new UniqueEntityID().toString(), name, probability, archived: false }
    if (duplicateName([...this.props.stages, stage]))
      return left(new InvalidInputError('/name', 'another active stage has this name'))
    this.props.stages = [...this.props.stages, stage]
    this.props.updatedAt = now
    return right(stage.id)
  }

  reviseStage(
    stageId: string,
    change: {
      name?: LabelName | undefined
      probability?: Probability | undefined
      archived?: boolean | undefined
    },
    now: Date,
  ): Change {
    const current = this.stage(stageId)
    if (!current) return left(new ConflictError('the stage is not part of this pipeline'))
    const next: Stage = {
      ...current,
      ...(change.name ? { name: change.name } : {}),
      ...(change.probability ? { probability: change.probability } : {}),
      ...(change.archived === undefined ? {} : { archived: change.archived }),
    }
    const stages = this.props.stages.map((stage) => (stage.id === stageId ? next : stage))
    if (!stages.some((stage) => !stage.archived))
      return left(new ConflictError('a pipeline keeps at least one active stage'))
    if (duplicateName(stages))
      return left(new InvalidInputError('/name', 'another active stage has this name'))
    this.props.stages = stages
    this.props.updatedAt = now
    return right(undefined)
  }

  /** The new order must name every stage, archived ones included, exactly once. */
  reorder(stageIds: readonly string[], now: Date): Change {
    const known = new Set(this.props.stages.map((stage) => stage.id))
    if (
      stageIds.length !== known.size ||
      new Set(stageIds).size !== known.size ||
      stageIds.some((id) => !known.has(id))
    )
      return left(
        new InvalidInputError('/stageIds', 'must list every stage of the pipeline exactly once'),
      )
    this.props.stages = stageIds.map((id) => this.stage(id) as Stage)
    this.props.updatedAt = now
    return right(undefined)
  }

  setArchived(archived: boolean, now: Date): Change {
    if (this.props.archived === archived)
      return left(
        new ConflictError(
          archived ? 'the pipeline is already archived' : 'the pipeline is not archived',
        ),
      )
    this.props.archived = archived
    this.props.updatedAt = now
    return right(undefined)
  }

  toSnapshot(): Readonly<PipelineSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      name: this.props.name.value,
      stages: this.props.stages.map((stage, position) => ({
        id: stage.id,
        name: stage.name.value,
        probabilityBps: stage.probability.bps,
        archived: stage.archived,
        position,
      })),
      archived: this.props.archived,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}

/** Names are compared case-insensitively among active stages only. */
function duplicateName(stages: readonly Stage[]): string | null {
  const seen = new Set<string>()
  for (const stage of stages) {
    if (stage.archived) continue
    const key = stage.name.value.toLocaleLowerCase()
    if (seen.has(key)) return stage.name.value
    seen.add(key)
  }
  return null
}
