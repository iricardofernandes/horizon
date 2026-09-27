import { randomUUID } from 'node:crypto'
import { InMemoryCrmUnitOfWork } from 'test/repositories/in-memory-crm-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { Account } from '@/domain/entities/account'
import { foldHistory } from '@/domain/entities/opportunity'
import { UpdateAccountProfileUseCase } from './use-cases/manage-accounts'
import { CreateContactUseCase, EraseContactUseCase } from './use-cases/manage-contacts'
import {
  ChangeOpportunityUseCase,
  CreateOpportunityUseCase,
} from './use-cases/manage-opportunities'
import {
  ChangeListEntryUseCase,
  ChangePipelineUseCase,
  CreateListEntryUseCase,
  CreatePipelineUseCase,
} from './use-cases/manage-pipelines'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-27T12:00:00Z')
const clock = { now: () => now }

async function world() {
  const unitOfWork = new InMemoryCrmUnitOfWork()
  const tenantId = randomUUID()
  const accountId = randomUUID()
  const ownerId = randomUUID()
  await unitOfWork.inTenant(tenantId, async (scope) => {
    const account = Account.project(
      {
        tenantId,
        party: {
          kind: 'organization',
          legalName: 'Acme GmbH',
          tradeName: null,
          roles: ['prospect'],
          documentType: 'none',
          documentCountry: null,
          active: true,
        },
        now,
      },
      new UniqueEntityID(accountId),
    )
    if (account) await scope.accounts.create(account)
    await scope.owners.register(ownerId, now)
  })
  const context = { tenantId, actor: 'ana', requestId: null }
  const keyed = () => ({ ...context, idempotencyKey: randomUUID() })
  const createPipeline = new CreatePipelineUseCase(unitOfWork, clock)
  const { pipelineId } = valid(
    await createPipeline.execute({
      context: keyed(),
      name: 'Vendas',
      stages: [
        { name: 'Qualificação', probabilityBps: 1000 },
        { name: 'Proposta', probabilityBps: 5000 },
      ],
    }),
  )
  const stages = snapshotOf(unitOfWork.pipelines.get(pipelineId) as never).stages as {
    id: string
  }[]
  const lists = new CreateListEntryUseCase(unitOfWork, clock)
  const { entryId: sourceId } = valid(
    await lists.execute({ context: keyed(), kind: 'source', name: 'Indicação' }),
  )
  const { entryId: reasonId } = valid(
    await lists.execute({ context: keyed(), kind: 'loss-reason', name: 'Preço' }),
  )
  return {
    unitOfWork,
    tenantId,
    accountId,
    ownerId,
    context,
    keyed,
    pipelineId,
    stages,
    sourceId,
    reasonId,
    lists,
    changeList: new ChangeListEntryUseCase(unitOfWork, clock),
    changePipeline: new ChangePipelineUseCase(unitOfWork, clock),
    create: new CreateOpportunityUseCase(unitOfWork, clock),
    change: new ChangeOpportunityUseCase(unitOfWork, clock),
    createPipeline,
  }
}

const terms = (extra: object = {}) => ({
  title: 'Renovação 2027',
  expectedValue: { amount: '1500000', currency: 'BRL' },
  expectedCloseOn: '2026-12-15',
  ...extra,
})

describe('pipeline settings', () => {
  it('creates, renames, adds, revises, reorders and archives, auditing each change', async () => {
    const w = await world()
    const change = (change: object) =>
      w.changePipeline.execute({
        context: w.context,
        pipelineId: w.pipelineId,
        change: change as never,
      })
    valid(await change({ kind: 'rename', name: 'Vendas B2B' }))
    const { stageId } = valid(
      await change({ kind: 'add-stage', stage: { name: 'Negociação', probabilityBps: 8000 } }),
    )
    valid(await change({ kind: 'revise-stage', stageId, probabilityBps: 7000 }))
    const ids = [stageId as string, ...w.stages.map((stage) => stage.id)]
    valid(await change({ kind: 'reorder', stageIds: ids }))
    valid(await change({ kind: 'archive', archived: true }))
    expect((await change({ kind: 'archive', archived: true })).isLeft()).toBe(true)
    expect(
      (await change({ kind: 'add-stage', stage: { name: 'X', probabilityBps: 20_000 } })).isLeft(),
    ).toBe(true)
    expect((await change({ kind: 'revise-stage', stageId, name: '' })).isLeft()).toBe(true)
    expect((await change({ kind: 'revise-stage', stageId, probabilityBps: -5 })).isLeft()).toBe(
      true,
    )
    expect((await change({ kind: 'rename', name: '' })).isLeft()).toBe(true)
    expect((await change({ kind: 'reorder', stageIds: [] })).isLeft()).toBe(true)
    expect(
      (
        await w.changePipeline.execute({
          context: w.context,
          pipelineId: randomUUID(),
          change: { kind: 'rename', name: 'X' },
        })
      ).value,
    ).toMatchObject({ title: 'Resource not found' })
    expect(snapshotOf(w.unitOfWork.pipelines.get(w.pipelineId) as never)).toMatchObject({
      name: 'Vendas B2B',
      archived: true,
    })
    expect(w.unitOfWork.audit.map((entry) => entry.action)).toContain('pipeline.stages-reordered')
    expect(
      (
        await w.createPipeline.execute({
          context: w.keyed(),
          name: 'X',
          stages: [{ name: 'A', probabilityBps: 1.5 }],
        })
      ).isLeft(),
    ).toBe(true)
    expect(
      (await w.createPipeline.execute({ context: w.keyed(), name: '', stages: [] })).isLeft(),
    ).toBe(true)
    expect(
      (await w.createPipeline.execute({ context: w.keyed(), name: 'Vazio', stages: [] })).isLeft(),
    ).toBe(true)
  })

  it('treats a retried creation with another request id as the same command', async () => {
    const w = await world()
    const key = w.keyed()
    const body = { name: 'Parceiros', stages: [{ name: 'Contato', probabilityBps: 500 }] }
    const first = valid(
      await w.createPipeline.execute({ ...body, context: { ...key, requestId: 'a' } }),
    )
    expect(
      valid(await w.createPipeline.execute({ ...body, context: { ...key, requestId: 'b' } })),
    ).toEqual(first)
    const entryKey = w.keyed()
    const entry = valid(
      await w.lists.execute({
        context: { ...entryKey, requestId: 'a' },
        kind: 'source',
        name: 'Feira',
      }),
    )
    expect(
      valid(
        await w.lists.execute({
          context: { ...entryKey, requestId: 'b' },
          kind: 'source',
          name: 'Feira',
        }),
      ),
    ).toEqual(entry)
  })

  it('keeps active names unique per list, archives and restores', async () => {
    const w = await world()
    expect(
      (await w.lists.execute({ context: w.keyed(), kind: 'source', name: 'indicação' })).value,
    ).toMatchObject({ title: 'Conflict' })
    expect(
      (
        await w.lists.execute({ context: w.keyed(), kind: 'loss-reason', name: 'Indicação' })
      ).isRight(),
    ).toBe(true)
    valid(
      await w.changeList.execute({
        context: w.context,
        kind: 'source',
        entryId: w.sourceId,
        archived: true,
      }),
    )
    const { entryId } = valid(
      await w.lists.execute({ context: w.keyed(), kind: 'source', name: 'Indicação' }),
    )
    expect(
      (
        await w.changeList.execute({
          context: w.context,
          kind: 'source',
          entryId: w.sourceId,
          archived: false,
        })
      ).value,
    ).toMatchObject({ title: 'Conflict' })
    valid(
      await w.changeList.execute({ context: w.context, kind: 'source', entryId, name: 'Parceiro' }),
    )
    expect(
      (await w.changeList.execute({ context: w.context, kind: 'loss-reason', entryId, name: 'X' }))
        .value,
    ).toMatchObject({ title: 'Resource not found' })
    expect(
      (
        await w.changeList.execute({ context: w.context, kind: 'source', entryId, name: '' })
      ).isLeft(),
    ).toBe(true)
    expect((await w.lists.execute({ context: w.keyed(), kind: 'source', name: '' })).isLeft()).toBe(
      true,
    )
  })
})

describe('opportunities', () => {
  it('opens once per key on an active account, with an active owner, source and account contacts', async () => {
    const w = await world()
    const contacts = new CreateContactUseCase(w.unitOfWork, clock)
    const { contactId } = valid(
      await contacts.execute({
        context: w.keyed(),
        accountId: w.accountId,
        contact: { name: 'João', lawfulBasis: 'contract' },
      }),
    )
    const request = {
      accountId: w.accountId,
      ownerId: w.ownerId,
      pipelineId: w.pipelineId,
      stageId: w.stages[0]?.id as string,
      terms: terms({ sourceId: w.sourceId, contactIds: [contactId] }),
    }
    const context = w.keyed()
    const first = valid(
      await w.create.execute({ ...request, context: { ...context, requestId: 'req-1' } }),
    )
    // A retry through the gateway carries another request id; it is still the same command.
    expect(
      valid(await w.create.execute({ ...request, context: { ...context, requestId: 'req-2' } })),
    ).toEqual(first)
    expect(w.unitOfWork.opportunities.size).toBe(1)
    expect(w.unitOfWork.published.map((event) => event.eventType)).toEqual([
      'crm.opportunity.created',
    ])

    const refused = async (change: object) =>
      (await w.create.execute({ ...request, ...change, context: w.keyed() })).value
    expect(await refused({ ownerId: randomUUID() })).toMatchObject({ field: '/ownerId' })
    expect(await refused({ terms: terms({ sourceId: w.reasonId }) })).toMatchObject({
      field: '/sourceId',
    })
    expect(await refused({ terms: terms({ contactIds: [randomUUID()] }) })).toMatchObject({
      field: '/contactIds',
    })
    expect(await refused({ stageId: randomUUID() })).toMatchObject({ title: 'Conflict' })
    expect(await refused({ pipelineId: randomUUID() })).toMatchObject({
      title: 'Resource not found',
    })
    expect(await refused({ accountId: randomUUID() })).toMatchObject({
      title: 'Resource not found',
    })
    expect(await refused({ terms: terms({ expectedCloseOn: '2026-13-01' }) })).toMatchObject({
      field: '/expectedCloseOn',
    })
    await new EraseContactUseCase(w.unitOfWork, clock).execute({ context: w.context, contactId })
    expect(await refused({ terms: terms({ contactIds: [contactId] }) })).toMatchObject({
      field: '/contactIds',
    })
    valid(
      await w.changeList.execute({
        context: w.context,
        kind: 'source',
        entryId: w.sourceId,
        archived: true,
      }),
    )
    expect(await refused({ terms: terms({ sourceId: w.sourceId }) })).toMatchObject({
      field: '/sourceId',
    })
  })

  it('moves, reassigns, loses, reopens and wins, and the history rebuilds the record', async () => {
    const w = await world()
    const [first, second] = w.stages.map((stage) => stage.id) as [string, string]
    const { opportunityId } = valid(
      await w.create.execute({
        context: w.keyed(),
        accountId: w.accountId,
        ownerId: w.ownerId,
        pipelineId: w.pipelineId,
        stageId: first,
        terms: terms(),
      }),
    )
    const request = { context: w.context, opportunityId }
    const other = randomUUID()
    await w.unitOfWork.inTenant(w.tenantId, (scope) => scope.owners.register(other, now))
    valid(await w.change.move({ ...request, stageId: second }))
    valid(await w.change.reassign({ ...request, ownerId: other }))
    expect((await w.change.reassign({ ...request, ownerId: randomUUID() })).isLeft()).toBe(true)
    expect(valid(await w.change.revise({ ...request, terms: terms() }))).toBe(false)
    expect(
      valid(await w.change.revise({ ...request, terms: terms({ expectedCloseOn: '2027-01-31' }) })),
    ).toBe(true)
    expect((await w.change.lose({ ...request, lossReasonId: w.sourceId })).isLeft()).toBe(true)
    expect(
      (
        await w.change.lose({ ...request, lossReasonId: w.reasonId, note: 'x'.repeat(501) })
      ).isLeft(),
    ).toBe(true)
    valid(await w.change.lose({ ...request, lossReasonId: w.reasonId, note: ' Caro ' }))
    valid(await w.change.reopen({ ...request, stageId: first }))
    valid(await w.change.win(request))
    expect((await w.change.win(request)).value).toMatchObject({ title: 'Conflict' })
    expect((await w.change.win({ ...request, opportunityId: randomUUID() })).value).toMatchObject({
      title: 'Resource not found',
    })

    const opportunity = w.unitOfWork.opportunities.get(opportunityId)
    if (!opportunity) throw new Error('missing')
    const history = w.unitOfWork.history.get(opportunityId) ?? []
    expect(history.map((recorded) => recorded.fact.type)).toEqual([
      'created',
      'stage-changed',
      'owner-changed',
      'revised',
      'lost',
      'reopened',
      'won',
    ])
    expect(foldHistory(history)).toEqual(opportunity.state)
    expect(
      w.unitOfWork.published.map((event) => event.eventType.replace('crm.opportunity.', '')),
    ).toEqual(['created', 'stage-changed', 'owner-changed', 'revised', 'lost', 'reopened', 'won'])
    const actions = w.unitOfWork.audit
      .filter((entry) => entry.subjectType === 'opportunity')
      .map((entry) => entry.action)
    expect(actions).toEqual([
      'opportunity.created',
      'opportunity.stage-changed',
      'opportunity.owner-changed',
      'opportunity.revised',
      'opportunity.lost',
      'opportunity.reopened',
      'opportunity.won',
    ])
  })

  it('keeps opportunities on an archived stage and refuses it as a destination', async () => {
    const w = await world()
    const [first, second] = w.stages.map((stage) => stage.id) as [string, string]
    const { opportunityId } = valid(
      await w.create.execute({
        context: w.keyed(),
        accountId: w.accountId,
        ownerId: w.ownerId,
        pipelineId: w.pipelineId,
        stageId: second,
        terms: terms(),
      }),
    )
    valid(
      await w.changePipeline.execute({
        context: w.context,
        pipelineId: w.pipelineId,
        change: { kind: 'revise-stage', stageId: second, archived: true },
      }),
    )
    expect(w.unitOfWork.opportunities.get(opportunityId)?.state.stageId).toBe(second)
    valid(await w.change.move({ context: w.context, opportunityId, stageId: first }))
    expect(
      (await w.change.move({ context: w.context, opportunityId, stageId: second })).value,
    ).toMatchObject({ title: 'Conflict' })
  })

  it('adds a source to an account profile, only an active one', async () => {
    const w = await world()
    const profile = new UpdateAccountProfileUseCase(w.unitOfWork, clock)
    const update = (sourceId: string) =>
      profile.execute({ context: w.context, accountId: w.accountId, profile: { sourceId } })
    expect(valid(await update(w.sourceId))).toEqual({ changed: ['sourceId'] })
    expect((await update(w.reasonId)).value).toMatchObject({ field: '/sourceId' })
    valid(
      await w.changeList.execute({
        context: w.context,
        kind: 'source',
        entryId: w.sourceId,
        archived: true,
      }),
    )
    const { entryId } = valid(
      await w.lists.execute({ context: w.keyed(), kind: 'source', name: 'Evento' }),
    )
    valid(
      await w.changeList.execute({ context: w.context, kind: 'source', entryId, archived: true }),
    )
    expect((await update(entryId)).value).toMatchObject({ field: '/sourceId' })
  })
})
