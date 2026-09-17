import type {
  ParsedStatement,
  ParsedStatementLine,
  StatementAdapter,
} from '@/application/ports/statement-adapter'
import { type Either, left, right } from '@/core/either'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { calendarDateOf, minorUnitsOf } from './amounts'

/** The value of `<TAG>value` in OFX 1.x SGML or `<TAG>value</TAG>` in OFX 2.x XML. */
function tag(block: string, name: string): string | null {
  const match = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block)
  const value = match?.[1]?.trim()
  return value ? decodeEntities(value) : null
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function blocks(content: string, name: string): string[] {
  const pattern = new RegExp(`<${name}>([\\s\\S]*?)(?=</${name}>|<${name}>|</BANKTRANLIST>)`, 'gi')
  return [...content.matchAll(pattern)].map((match) => match[1] ?? '')
}

function lineOf(block: string, index: number): Either<InvalidInputError, ParsedStatementLine> {
  const postedOn = calendarDateOf(tag(block, 'DTPOSTED') ?? '')
  if (!postedOn)
    return left(new InvalidInputError(`/lines/${index}/postedOn`, 'DTPOSTED is missing or invalid'))
  const amount = minorUnitsOf(tag(block, 'TRNAMT') ?? '')
  if (amount === null)
    return left(new InvalidInputError(`/lines/${index}/amount`, 'TRNAMT is missing or invalid'))
  const name = tag(block, 'NAME')
  const memo = tag(block, 'MEMO')
  const raw: Record<string, string> = {}
  for (const field of [
    'TRNTYPE',
    'DTPOSTED',
    'TRNAMT',
    'FITID',
    'CHECKNUM',
    'REFNUM',
    'NAME',
    'MEMO',
  ]) {
    const value = tag(block, field)
    if (value !== null) raw[field] = value
  }
  return right({
    postedOn,
    amount,
    bankReference: tag(block, 'FITID'),
    documentId: tag(block, 'CHECKNUM') ?? tag(block, 'REFNUM'),
    description: [name, memo].filter(Boolean).join(' · ') || (tag(block, 'TRNTYPE') ?? ''),
    counterparty: name,
    raw,
  })
}

/** OFX 1.x (SGML) and 2.x (XML) bank statements, as Brazilian banks export them. */
export class OfxStatementAdapter implements StatementAdapter {
  readonly format = 'ofx' as const

  parse(content: string): Either<InvalidInputError, ParsedStatement> {
    if (!/<OFX>/i.test(content))
      return left(new InvalidInputError('/content', 'is not an OFX statement'))
    const lines: ParsedStatementLine[] = []
    for (const [index, block] of blocks(content, 'STMTTRN').entries()) {
      const line = lineOf(block, index)
      if (line.isLeft()) return left(line.value)
      lines.push(line.value)
    }
    const ledger = blocks(content, 'LEDGERBAL')[0]
    const balanceAmount = ledger ? minorUnitsOf(tag(ledger, 'BALAMT') ?? '') : null
    const balanceOn = ledger ? calendarDateOf(tag(ledger, 'DTASOF') ?? '') : null
    return right({
      currency: tag(content, 'CURDEF')?.toUpperCase() ?? null,
      accountReference: tag(content, 'ACCTID'),
      closingBalance:
        balanceAmount !== null && balanceOn ? { amount: balanceAmount, on: balanceOn } : null,
      lines,
    })
  }
}
