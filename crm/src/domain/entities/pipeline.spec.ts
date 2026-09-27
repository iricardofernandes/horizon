import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { LabelName, Probability } from '../value-objects/crm-values'
import { Pipeline } from './pipeline'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-27T12:00:00Z')
const stage = (name: string, bps: number) => ({
  name: valid(LabelName.create(name)),
  probability: valid(Probability.create(bps)),
})

function pipeline() {
  return valid(
    Pipeline.create({
      tenantId: 'tenant-a',
      name: valid(LabelName.create('Vendas')),
      stages: [stage('Qualificação', 1000), stage('Proposta', 5000), stage('Negociação', 8000)],
      now,
    }),
  )
}

describe('pipelines', () => {
  it('needs a stage, and no two active stages with the same name', () => {
    const name = valid(LabelName.create('Vazio'))
    expect(Pipeline.create({ tenantId: 't', name, stages: [], now }).isLeft()).toBe(true)
    expect(
      Pipeline.create({
        tenantId: 't',
        name,
        stages: [stage('A', 1), stage('a', 2)],
        now,
      }).isLeft(),
    ).toBe(true)
    const sales = pipeline()
    expect(
      sales
        .addStage(valid(LabelName.create('proposta')), valid(Probability.create(1)), now)
        .isLeft(),
    ).toBe(true)
  })

  it('bounds probability in basis points', () => {
    expect(Probability.create(-1).isLeft()).toBe(true)
    expect(Probability.create(10_001).isLeft()).toBe(true)
    expect(Probability.create(12.5).isLeft()).toBe(true)
  })

  it('archives a stage out of the destinations and keeps one active stage', () => {
    const sales = pipeline()
    const [first, second, third] = snapshotOf(sales).stages
    if (!first || !second || !third) throw new Error('stages missing')
    expect(sales.reviseStage(second.id, { archived: true }, now).isRight()).toBe(true)
    expect(sales.destination(second.id).isLeft()).toBe(true)
    expect(sales.stage(second.id)?.archived).toBe(true)
    sales.reviseStage(third.id, { archived: true }, now)
    expect(sales.reviseStage(first.id, { archived: true }, now).isLeft()).toBe(true)
    // An archived stage may share a name with a new active one.
    expect(
      sales
        .addStage(valid(LabelName.create('Proposta')), valid(Probability.create(4000)), now)
        .isRight(),
    ).toBe(true)
    expect(sales.reviseStage('unknown', { archived: false }, now).isLeft()).toBe(true)
  })

  it('reorders only with every stage named once, and re-weights a stage', () => {
    const sales = pipeline()
    const ids = snapshotOf(sales).stages.map((entry) => entry.id)
    expect(sales.reorder([...ids].reverse(), now).isRight()).toBe(true)
    expect(snapshotOf(sales).stages.map((entry) => entry.position)).toEqual([0, 1, 2])
    expect(snapshotOf(sales).stages[0]?.id).toBe(ids[2])
    expect(sales.reorder(ids.slice(1), now).isLeft()).toBe(true)
    expect(
      sales.reorder([ids[0] as string, ids[0] as string, ids[1] as string], now).isLeft(),
    ).toBe(true)
    sales.reviseStage(
      ids[0] as string,
      { probability: valid(Probability.create(2000)), name: valid(LabelName.create('Lead')) },
      now,
    )
    expect(sales.stage(ids[0] as string)?.probability.bps).toBe(2000)
  })

  it('takes no opportunity while archived', () => {
    const sales = pipeline()
    const [first] = snapshotOf(sales).stages
    expect(sales.setArchived(true, now).isRight()).toBe(true)
    expect(sales.setArchived(true, now).isLeft()).toBe(true)
    expect(sales.destination(first?.id as string).isLeft()).toBe(true)
    sales.setArchived(false, now)
    sales.rename(valid(LabelName.create('Vendas B2B')), now)
    expect(snapshotOf(sales)).toMatchObject({ name: 'Vendas B2B', archived: false })
  })
})
