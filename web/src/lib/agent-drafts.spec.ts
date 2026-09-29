import { describe, expect, it } from 'vitest'
import { draftIdsOf, withDrafts } from './agent-drafts'

describe('agent drafts in the lists', () => {
  it('reads the ids the agent log answered, and nothing from a strange body', () => {
    expect([...draftIdsOf({ data: [{ recordId: 'a' }, { recordId: 7 }, {}] })]).toEqual(['a'])
    expect(draftIdsOf(null).size).toBe(0)
    expect(draftIdsOf({ detail: 'forbidden' }).size).toBe(0)
  })

  it('keeps every row, or only the drafted ones, by any of their ids', () => {
    const rows = [
      { id: 'v2', rootId: 'q1' },
      { id: 'q2', rootId: 'q2' },
    ]
    const ids = new Set(['q1'])
    const idsOf = (row: { id: string; rootId: string }) => [row.id, row.rootId]
    expect(withDrafts(rows, ids, idsOf, false)).toHaveLength(2)
    expect(withDrafts(rows, ids, idsOf, true)).toEqual([{ id: 'v2', rootId: 'q1' }])
  })
})
