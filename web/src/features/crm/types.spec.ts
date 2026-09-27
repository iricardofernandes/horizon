import { describe, expect, it } from 'vitest'
import {
  type Account,
  boardStages,
  durationParts,
  instantFromLocal,
  localInputOf,
  needsCustomerRole,
  neighbourStage,
  type Opportunity,
  type Pipeline,
  personLabel,
} from './types'

const pipeline: Pipeline = {
  id: 'p',
  name: 'Vendas',
  archived: false,
  stages: [
    { id: 'a', name: 'Qualificação', probabilityBps: 1000, archived: false, position: 0 },
    { id: 'b', name: 'Antiga', probabilityBps: 3000, archived: true, position: 1 },
    { id: 'c', name: 'Proposta', probabilityBps: 5000, archived: false, position: 2 },
  ],
}

describe('the pipeline board', () => {
  it('moves a card to the next or previous active stage, skipping archived ones', () => {
    expect(neighbourStage(pipeline, 'a', 'next')?.id).toBe('c')
    expect(neighbourStage(pipeline, 'c', 'previous')?.id).toBe('a')
    expect(neighbourStage(pipeline, 'c', 'next')).toBeNull()
    expect(neighbourStage(pipeline, 'a', 'previous')).toBeNull()
    // Leaving an archived stage is allowed; the move lands on an active neighbour.
    expect(neighbourStage(pipeline, 'b', 'next')?.id).toBe('c')
  })

  it('shows an archived stage only while an open opportunity still sits in it', () => {
    expect(boardStages(pipeline, []).map((stage) => stage.id)).toEqual(['a', 'c'])
    const held = [{ stageId: 'b' } as Opportunity]
    expect(boardStages(pipeline, held).map((stage) => stage.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('labels and conversion', () => {
  it('names a person when Identity told us, and shows a short id otherwise', () => {
    const names = new Map([['0194c3d2-aaaa', 'Ana Souza']])
    expect(personLabel(names, '0194c3d2-aaaa', '—')).toBe('Ana Souza')
    expect(personLabel(names, '0194ffff-bbbb-cccc', '—')).toBe('0194ffff')
    expect(personLabel(names, null, 'Sem responsável')).toBe('Sem responsável')
  })

  it('makes a prospect a customer first, and leaves a customer as it is', () => {
    const account = { roles: ['prospect'] } as Account
    expect(needsCustomerRole(account)).toBe(true)
    expect(needsCustomerRole({ ...account, roles: ['prospect', 'customer'] })).toBe(false)
  })

  it('reads a duration in the unit that suits it', () => {
    expect(durationParts(90)).toEqual({ unit: 'minutes', value: 2 })
    expect(durationParts(5_400)).toEqual({ unit: 'hours', value: 1.5 })
    expect(durationParts(3 * 86_400)).toEqual({ unit: 'days', value: 3 })
  })

  it('turns a local date-time input into an instant and back', () => {
    const now = new Date('2026-09-27T15:04:00.000Z')
    expect(instantFromLocal(localInputOf(now))).toBe(now.toISOString())
    expect(instantFromLocal('')).toBeNull()
  })
})
