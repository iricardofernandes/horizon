import { describe, expect, it } from 'vitest'
import { instantOf, RecordText, subjectOf } from './record-values'

describe('record values', () => {
  it('keeps the line breaks of a long text but not its stray whitespace', () => {
    const text = RecordText.long('  Primeira linha  \r\n\r\n\r\n\tSegunda\t \n', '/body', 100)
    expect(text.isRight() && text.value.value).toBe('Primeira linha\n\n\tSegunda')
    expect(RecordText.long(' \n ', '/body', 100).isLeft()).toBe(true)
    expect(RecordText.long('x'.repeat(101), '/body', 100).isLeft()).toBe(true)
  })

  it('collapses a single line and bounds it', () => {
    const line = RecordText.line('  Ligar   para\no cliente ', '/title')
    expect(line.isRight() && line.value.value).toBe('Ligar para o cliente')
    expect(RecordText.line('x', '/title').isLeft()).toBe(true)
  })

  it('accepts only instants with an offset, and only known subjects', () => {
    expect(instantOf('2026-09-28T12:00:00-03:00', '/dueAt').isRight()).toBe(true)
    expect(instantOf('2026-09-28T12:00:00', '/dueAt').isLeft()).toBe(true)
    expect(instantOf('2026-02-30T12:00:00Z', '/dueAt').isLeft()).toBe(true)
    expect(instantOf('2026-09-28T24:00:00Z', '/dueAt').isLeft()).toBe(true)
    expect(instantOf('2028-02-29T23:59:59.999Z', '/dueAt').isRight()).toBe(true)
    expect(subjectOf('quote', 'x').isLeft()).toBe(true)
  })
})
