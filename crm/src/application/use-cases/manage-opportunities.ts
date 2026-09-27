import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { Opportunity } from '@/domain/entities/opportunity'
import type { Stage } from '@/domain/entities/pipeline'
import {
  BusinessDate,
  type ListKind,
  Money,
  OpportunityTitle,
} from '@/domain/value-objects/crm-values'
import type { Clock } from '../ports/clock'
import type { CrmScope, CrmUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext, type IdempotentContext, once } from './commands'

type Failure = InvalidInputError | ConflictError | ResourceNotFoundError

export interface OpportunityTermsInput {
  readonly title: string
  readonly contactIds?: readonly string[] | undefined
  readonly sourceId?: string | null | undefined
  readonly expectedValue: { readonly amount: string; readonly currency: string }
  readonly expectedCloseOn: string
}

interface Terms {
  readonly title: OpportunityTitle
  readonly contactIds: readonly string[]
  readonly sourceId: string | null
  readonly expectedValue: Money
  readonly expectedCloseOn: BusinessDate
}

function termsOf(input: OpportunityTermsInput): Either<InvalidInputError, Terms> {
  const title = OpportunityTitle.create(input.title)
  if (title.isLeft()) return left(title.value)
  const value = Money.create(input.expectedValue.amount, input.expectedValue.currency)
  if (value.isLeft()) return left(value.value)
  const closeOn = BusinessDate.create(input.expectedCloseOn)
  if (closeOn.isLeft()) return left(closeOn.value)
  return right({
    title: title.value,
    contactIds: input.contactIds ?? [],
    sourceId: input.sourceId ?? null,
    expectedValue: value.value,
    expectedCloseOn: closeOn.value,
  })
}

/** A list entry may be chosen only while active; it stays where it already was if archived later. */
async function selectable(
  scope: CrmScope,
  kind: ListKind,
  id: string | null,
  field: string,
  current: string | null = null,
): Promise<InvalidInputError | null> {
  if (id === null || id === current) return null
  const entry = await scope.lists.findById(id)
  if (!entry || entry.kind !== kind)
    return new InvalidInputError(field, `is not a ${kind} of this workspace`)
  if (!entry.isSelectable()) return new InvalidInputError(field, `is an archived ${kind}`)
  return null
}

/** Contacts named on a record are live contacts of its own account. */
export async function contactsOf(
  scope: CrmScope,
  accountId: string,
  contactIds: readonly string[],
): Promise<InvalidInputError | null> {
  for (const contactId of new Set(contactIds)) {
    const contact = await scope.contacts.findById(contactId)
    if (!contact || contact.accountId !== accountId || contact.isErased())
      return new InvalidInputError('/contactIds', `${contactId} is not a contact of this account`)
  }
  return null
}

export async function activeOwner(
  scope: CrmScope,
  ownerId: string,
): Promise<InvalidInputError | null> {
  const owner = await scope.owners.find(ownerId)
  if (!owner) return new InvalidInputError('/ownerId', 'is not a user of this workspace')
  if (!owner.active) return new InvalidInputError('/ownerId', 'is a disabled user')
  return null
}

export class CreateOpportunityUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly context: IdempotentContext
    readonly accountId: string
    readonly ownerId: string
    readonly pipelineId: string
    readonly stageId: string
    readonly terms: OpportunityTermsInput
  }): Promise<Either<Failure, { opportunityId: string }>> {
    const terms = termsOf(request.terms)
    if (terms.isLeft()) return left(terms.value)
    const { context } = request
    // The fingerprint is what was asked, never who asked or the request id (Phase 50).
    const { context: _, ...asked } = request
    return once(this.unitOfWork, context, 'opportunity.create', asked, async (scope) => {
      const account = await scope.accounts.findById(request.accountId)
      if (!account) return left(new ResourceNotFoundError('account was not found'))
      if (!account.acceptsContacts())
        return left(new ConflictError('opportunities are opened only on an active account'))
      const pipeline = await scope.pipelines.findById(request.pipelineId)
      if (!pipeline) return left(new ResourceNotFoundError('pipeline was not found'))
      const stage = pipeline.destination(request.stageId)
      if (stage.isLeft()) return left(stage.value)
      const refused =
        (await activeOwner(scope, request.ownerId)) ??
        (await selectable(scope, 'source', terms.value.sourceId, '/sourceId')) ??
        (await contactsOf(scope, request.accountId, terms.value.contactIds))
      if (refused) return left(refused)
      const now = this.clock.now()
      const opportunity = Opportunity.open(
        {
          ...terms.value,
          tenantId: context.tenantId,
          accountId: request.accountId,
          ownerId: request.ownerId,
          pipelineId: request.pipelineId,
          stage: stage.value,
          actor: context.actor,
          now,
        },
        new UniqueEntityID(),
      )
      await scope.opportunities.create(opportunity)
      const opportunityId = opportunity.id.toString()
      await audit(scope, context, {
        action: 'opportunity.created',
        subjectType: 'opportunity',
        subjectId: opportunityId,
        occurredAt: now,
        details: { accountId: request.accountId, pipelineId: request.pipelineId },
      })
      return right({ opportunityId })
    })
  }
}

/** Load, decide, save and audit one opportunity inside one tenant transaction. */
async function withOpportunity<T>(
  unitOfWork: CrmUnitOfWork,
  context: CommandContext,
  opportunityId: string,
  action: string,
  decide: (opportunity: Opportunity, scope: CrmScope, now: Date) => Promise<Either<Failure, T>>,
  clock: Clock,
): Promise<Either<Failure, T>> {
  return unitOfWork.inTenant(context.tenantId, async (scope) => {
    const opportunity = await scope.opportunities.findById(opportunityId)
    if (!opportunity) return left(new ResourceNotFoundError('opportunity was not found'))
    const now = clock.now()
    const loaded = opportunity.state.version
    const outcome = await decide(opportunity, scope, now)
    if (outcome.isLeft()) return outcome
    // A revision that changed nothing records nothing.
    if (opportunity.state.version === loaded) return outcome
    await scope.opportunities.save(opportunity)
    await audit(scope, context, {
      action,
      subjectType: 'opportunity',
      subjectId: opportunityId,
      occurredAt: now,
      details: { version: opportunity.state.version },
    })
    return outcome
  })
}

/** The stage an opportunity may move or be reopened into, in its own pipeline. */
async function destination(
  scope: CrmScope,
  opportunity: Opportunity,
  stageId: string,
): Promise<Either<Failure, Stage>> {
  const pipeline = await scope.pipelines.findById(opportunity.state.pipelineId)
  if (!pipeline) return left(new ResourceNotFoundError('pipeline was not found'))
  return pipeline.destination(stageId)
}

export class ChangeOpportunityUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  revise(request: {
    readonly context: CommandContext
    readonly opportunityId: string
    readonly terms: OpportunityTermsInput
  }): Promise<Either<Failure, boolean>> {
    const terms = termsOf(request.terms)
    if (terms.isLeft()) return Promise.resolve(left(terms.value))
    return this.run(request, 'opportunity.revised', async (opportunity, scope, now) => {
      const refused =
        (await selectable(
          scope,
          'source',
          terms.value.sourceId,
          '/sourceId',
          opportunity.state.sourceId,
        )) ?? (await contactsOf(scope, opportunity.state.accountId, terms.value.contactIds))
      if (refused) return left(refused)
      return opportunity.revise(terms.value, request.context.actor, now)
    })
  }

  move(request: {
    readonly context: CommandContext
    readonly opportunityId: string
    readonly stageId: string
  }) {
    return this.run(request, 'opportunity.stage-changed', async (opportunity, scope, now) => {
      const stage = await destination(scope, opportunity, request.stageId)
      if (stage.isLeft()) return left(stage.value)
      return opportunity.move(stage.value, request.context.actor, now)
    })
  }

  reassign(request: {
    readonly context: CommandContext
    readonly opportunityId: string
    readonly ownerId: string
  }) {
    return this.run(request, 'opportunity.owner-changed', async (opportunity, scope, now) => {
      const refused = await activeOwner(scope, request.ownerId)
      if (refused) return left(refused)
      return opportunity.reassign(request.ownerId, request.context.actor, now)
    })
  }

  win(request: { readonly context: CommandContext; readonly opportunityId: string }) {
    return this.run(request, 'opportunity.won', async (opportunity, _scope, now) =>
      opportunity.win(BusinessDate.of(now), request.context.actor, now),
    )
  }

  lose(request: {
    readonly context: CommandContext
    readonly opportunityId: string
    readonly lossReasonId: string
    readonly note?: string | null | undefined
  }) {
    const note = request.note?.trim() ? request.note.trim() : null
    if (note && note.length > 500)
      return Promise.resolve(
        left(new InvalidInputError('/note', 'must contain at most 500 characters')),
      )
    return this.run(request, 'opportunity.lost', async (opportunity, scope, now) => {
      const refused = await selectable(scope, 'loss-reason', request.lossReasonId, '/lossReasonId')
      if (refused) return left(refused)
      return opportunity.lose(
        request.lossReasonId,
        note,
        BusinessDate.of(now),
        request.context.actor,
        now,
      )
    })
  }

  reopen(request: {
    readonly context: CommandContext
    readonly opportunityId: string
    readonly stageId: string
  }) {
    return this.run(request, 'opportunity.reopened', async (opportunity, scope, now) => {
      const stage = await destination(scope, opportunity, request.stageId)
      if (stage.isLeft()) return left(stage.value)
      return opportunity.reopen(stage.value, request.context.actor, now)
    })
  }

  private run<T>(
    request: { readonly context: CommandContext; readonly opportunityId: string },
    action: string,
    decide: (opportunity: Opportunity, scope: CrmScope, now: Date) => Promise<Either<Failure, T>>,
  ): Promise<Either<Failure, T>> {
    return withOpportunity(
      this.unitOfWork,
      request.context,
      request.opportunityId,
      action,
      decide,
      this.clock,
    )
  }
}
