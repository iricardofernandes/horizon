import { randomUUID } from 'node:crypto'
import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { RecordText } from '../value-objects/record-values'
import { Note } from './note'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const body = (value: string) => valid(RecordText.long(value, '/body', 10_000))

describe('note', () => {
  it('keeps every earlier text when it is corrected', () => {
    const accountId = randomUUID()
    const note = Note.write({
      tenantId: randomUUID(),
      accountId,
      subject: { type: 'account', id: accountId },
      body: body('Cliente pediu desconto de 10%'),
      author: 'ana',
      now: new Date('2026-09-27T12:00:00Z'),
    })
    expect(note.pullNewRevisions().map((revision) => revision.revision)).toEqual([1])
    expect(
      valid(
        note.correct(
          body('Cliente pediu desconto de 5%'),
          'bruno',
          new Date('2026-09-27T13:00:00Z'),
        ),
      ),
    ).toBe(2)
    expect(note.correct(body('Cliente pediu desconto de 5%'), 'bruno', new Date()).isLeft()).toBe(
      true,
    )
    expect(note.pullNewRevisions().map((revision) => revision.revision)).toEqual([2])
    expect(note.pullNewRevisions()).toEqual([])
    const snapshot = snapshotOf(note)
    expect(snapshot.body).toBe('Cliente pediu desconto de 5%')
    expect(
      snapshot.revisions.map((revision) => [revision.revision, revision.body, revision.author]),
    ).toEqual([
      [1, 'Cliente pediu desconto de 10%', 'ana'],
      [2, 'Cliente pediu desconto de 5%', 'bruno'],
    ])
  })
})
