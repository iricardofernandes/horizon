import type {
  ParsedStatement,
  ParsedStatementLine,
  StatementAdapter,
} from '@/application/ports/statement-adapter'
import { type Either, left, right } from '@/core/either'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { calendarDateOf, minorUnitsOf } from './amounts'

/** Header names accepted for each column, in Portuguese and English, lower-cased. */
const COLUMNS = {
  date: ['date', 'data', 'posted on', 'data lançamento', 'data lancamento'],
  amount: ['amount', 'valor', 'value'],
  description: ['description', 'descrição', 'descricao', 'histórico', 'historico', 'memo'],
  reference: ['reference', 'referência', 'referencia', 'id', 'fitid'],
  document: ['document', 'documento', 'doc'],
  counterparty: ['counterparty', 'favorecido', 'contraparte', 'name', 'nome'],
  balance: ['balance', 'saldo'],
} as const

type Column = keyof typeof COLUMNS

/** Splits one CSV record, honouring double quotes and doubled quotes inside them. */
function cells(line: string, delimiter: string): string[] {
  const result: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else if (char === '"') quoted = false
      else current += char
    } else if (char === '"') quoted = true
    else if (char === delimiter) {
      result.push(current.trim())
      current = ''
    } else current += char
  }
  result.push(current.trim())
  return result
}

function headerMap(header: string[]): Either<InvalidInputError, Partial<Record<Column, number>>> {
  const normalized = header.map((name) => name.trim().toLowerCase().replace(/^﻿/, ''))
  const map: Partial<Record<Column, number>> = {}
  for (const column of Object.keys(COLUMNS) as Column[]) {
    const index = normalized.findIndex((name) =>
      (COLUMNS[column] as readonly string[]).includes(name),
    )
    if (index >= 0) map[column] = index
  }
  for (const required of ['date', 'amount', 'description'] as const)
    if (map[required] === undefined)
      return left(new InvalidInputError('/content', `the header needs a ${required} column`))
  return right(map)
}

function rowOf(
  row: string[],
  header: string[],
  map: Partial<Record<Column, number>>,
  index: number,
): Either<InvalidInputError, { line: ParsedStatementLine; balance: bigint | null }> {
  const at = (column: Column) => {
    const position = map[column]
    const value = position === undefined ? '' : (row[position] ?? '')
    return value === '' ? null : value
  }
  const postedOn = calendarDateOf(at('date') ?? '')
  const amount = minorUnitsOf(at('amount') ?? '')
  if (!postedOn || amount === null)
    return left(
      new InvalidInputError(`/lines/${index}`, `row ${index + 2} has an invalid date or amount`),
    )
  return right({
    line: {
      postedOn,
      amount,
      bankReference: at('reference'),
      documentId: at('document'),
      description: at('description') ?? '',
      counterparty: at('counterparty'),
      raw: Object.fromEntries(header.map((name, column) => [name, row[column] ?? ''])),
    },
    balance: minorUnitsOf(at('balance') ?? ''),
  })
}

/**
 * A CSV export with a header row: date, amount and description are required; reference,
 * document, counterparty and balance are optional. `;` or `,` delimited, decimal comma or dot.
 */
export class CsvStatementAdapter implements StatementAdapter {
  readonly format = 'csv' as const

  parse(content: string): Either<InvalidInputError, ParsedStatement> {
    const rows = content.split(/\r?\n/).filter((row) => row.trim() !== '')
    const [first, ...records] = rows
    if (!first) return left(new InvalidInputError('/content', 'the file is empty'))
    const delimiter =
      (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) ? ';' : ','
    const header = cells(first, delimiter)
    const map = headerMap(header)
    if (map.isLeft()) return left(map.value)
    const lines: ParsedStatementLine[] = []
    let closingBalance: ParsedStatement['closingBalance'] = null
    for (const [index, record] of records.entries()) {
      const parsed = rowOf(cells(record, delimiter), header, map.value, index)
      if (parsed.isLeft()) return left(parsed.value)
      lines.push(parsed.value.line)
      const { balance } = parsed.value
      if (balance !== null && (!closingBalance || parsed.value.line.postedOn >= closingBalance.on))
        closingBalance = { amount: balance, on: parsed.value.line.postedOn }
    }
    return right({ currency: null, accountReference: null, closingBalance, lines })
  }
}
