import { randomUUID } from 'node:crypto'
import { InMemoryCrmUnitOfWork } from 'test/repositories/in-memory-crm-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { Account } from '@/domain/entities/account'
import {
  ChangeOpportunityUseCase,
  CreateOpportunityUseCase,
} from './use-cases/manage-opportunities'
import { CreatePipelineUseCase } from './use-cases/manage-pipelines'
import { RebuildMetricsUseCase, type RebuildProgress } from './use-cases/rebuild-metrics'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const clock = { now: () => new Date('2026-09-27T12:00:00Z') }

async function world(opportunities: number) {
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
          legalName: 'Initech Ltda',
          tradeName: null,
          roles: ['prospect'],
          documentType: 'none',
          documentCountry: null,
          active: true,
        },
        now: clock.now(),
      },
      new UniqueEntityID(accountId),
    )
    if (account) await scope.accounts.create(account)
    await scope.owners.register(ownerId, clock.now())
  })
  const context = { tenantId, actor: ownerId, requestId: null }
  const { pipelineId } = valid(
    await new CreatePipelineUseCase(unitOfWork, clock).execute({
      context: { ...context, idempotencyKey: randomUUID() },
      name: 'Vendas',
      stages: [
        { name: 'Qualificação', probabilityBps: 1000 },
        { name: 'Proposta', probabilityBps: 5000 },
      ],
    }),
  )
  const stages = (
    snapshotOf(unitOfWork.pipelines.get(pipelineId) as never) as { stages: { id: string }[] }
  ).stages
  const ids: string[] = []
  for (let index = 0; index < opportunities; index += 1) {
    const { opportunityId } = valid(
      await new CreateOpportunityUseCase(unitOfWork, clock).execute({
        context: { ...context, idempotencyKey: randomUUID() },
        accountId,
        ownerId,
        pipelineId,
        stageId: stages[0]?.id ?? '',
        terms: {
          title: `Oportunidade ${index}`,
          expectedValue: { amount: `${(index + 1) * 1000}`, currency: 'BRL' },
          expectedCloseOn: '2026-12-01',
        },
      }),
    )
    valid(
      await new ChangeOpportunityUseCase(unitOfWork, clock).move({
        context,
        opportunityId,
        stageId: stages[1]?.id ?? '',
      }),
    )
    ids.push(opportunityId)
  }
  return { unitOfWork, tenantId, ids }
}

describe('rebuilding the metric rows', () => {
  it('walks every opportunity in batches and reports progress, with nothing to repair', async () => {
    const w = await world(5)
    const progress: RebuildProgress[] = []
    const result = await new RebuildMetricsUseCase(w.unitOfWork, 2).execute(w.tenantId, {
      onBatch: (step) => progress.push(step),
    })
    expect(progress.map((step) => step.processed)).toEqual([2, 4, 5])
    expect(result).toMatchObject({ processed: 5, drifted: 0, rebuilt: true })
  })

  it('finds rows that no longer match the history, and repairs them only when asked', async () => {
    const w = await world(3)
    const [tampered = ''] = w.ids
    w.unitOfWork.metricRows.set(tampered, { states: [], visits: [], closures: [] })
    const rebuild = new RebuildMetricsUseCase(w.unitOfWork, 2)
    expect(await rebuild.execute(w.tenantId, { verifyOnly: true })).toMatchObject({
      drifted: 1,
      driftedIds: [tampered],
      rebuilt: false,
    })
    expect(w.unitOfWork.metricRows.get(tampered)?.states).toEqual([])
    expect(await rebuild.execute(w.tenantId)).toMatchObject({ drifted: 1 })
    expect(w.unitOfWork.metricRows.get(tampered)?.states).toHaveLength(2)
    expect(await rebuild.execute(w.tenantId, { verifyOnly: true })).toMatchObject({ drifted: 0 })
  })

  it('never walks another tenant’s opportunities', async () => {
    const w = await world(2)
    const other = await new RebuildMetricsUseCase(w.unitOfWork).execute(randomUUID())
    expect(other.processed).toBe(0)
  })
})
