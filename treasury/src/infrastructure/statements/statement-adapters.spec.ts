import { describe, expect, it } from 'vitest'
import { calendarDateOf, minorUnitsOf } from './amounts'
import { CsvStatementAdapter } from './csv-adapter'
import { OfxStatementAdapter } from './ofx-adapter'

function valid<T>(result: { isLeft(): boolean; value: unknown }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

const sgml = `OFXHEADER:100
DATA:OFXSGML
<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>BRL
<BANKACCTFROM><BANKID>001<ACCTID>98765-0</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260901<DTEND>20260930
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260915120000[-3:BRT]
<TRNAMT>-1234.56
<FITID>2026091500001
<CHECKNUM>000123
<NAME>PAPELARIA CENTRAL
<MEMO>Pagamento boleto
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260916
<TRNAMT>500,00
<FITID>2026091600002
<MEMO>PIX RECEBIDO ACME &amp; FILHOS
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>8765.44<DTASOF>20260930</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`

describe('statement adapters', () => {
  it('reads OFX 1.x lines, keeping the bank reference, document and original description', () => {
    const statement = valid<{
      currency: string
      accountReference: string
      closingBalance: unknown
      lines: { amount: bigint; description: string; raw: Record<string, string> }[]
    }>(new OfxStatementAdapter().parse(sgml))
    expect(statement.currency).toBe('BRL')
    expect(statement.accountReference).toBe('98765-0')
    expect(statement.closingBalance).toEqual({ amount: 876_544n, on: '2026-09-30' })
    expect(statement.lines).toEqual([
      expect.objectContaining({
        postedOn: '2026-09-15',
        amount: -123_456n,
        bankReference: '2026091500001',
        documentId: '000123',
        counterparty: 'PAPELARIA CENTRAL',
        description: 'PAPELARIA CENTRAL · Pagamento boleto',
      }),
      expect.objectContaining({ amount: 50_000n, description: 'PIX RECEBIDO ACME & FILHOS' }),
    ])
    expect(statement.lines[0]?.raw.TRNTYPE).toBe('DEBIT')
  })

  it('reads a Brazilian CSV with semicolons, decimal commas and quoted fields', () => {
    const csv = [
      'Data;Histórico;Documento;Valor;Saldo',
      '15/09/2026;"Tarifa; pacote";991;-12,90;1.987,10',
      '16/09/2026;PIX recebido;;1.500,00;3.487,10',
    ].join('\n')
    const statement = valid<{
      closingBalance: unknown
      lines: { amount: bigint; description: string; documentId: string | null }[]
    }>(new CsvStatementAdapter().parse(csv))
    expect(statement.lines.map((line) => [line.amount, line.description, line.documentId])).toEqual(
      [
        [-1290n, 'Tarifa; pacote', '991'],
        [150_000n, 'PIX recebido', null],
      ],
    )
    expect(statement.closingBalance).toEqual({ amount: 348_710n, on: '2026-09-16' })
  })

  it('refuses files that are not statements or rows it cannot read', () => {
    expect(new OfxStatementAdapter().parse('date,amount').isLeft()).toBe(true)
    expect(new CsvStatementAdapter().parse('foo,bar\n1,2').isLeft()).toBe(true)
    expect(
      new CsvStatementAdapter().parse('date,amount,description\n31/02/2026,1,x').isLeft(),
    ).toBe(true)
  })

  it('parses amounts and dates in the shapes banks print them', () => {
    expect(minorUnitsOf('(1.234,5)')).toBe(-123_450n)
    expect(minorUnitsOf('R$ 10')).toBe(1000n)
    expect(minorUnitsOf('1,234,567.89')).toBe(123_456_789n)
    expect(minorUnitsOf('abc')).toBeNull()
    expect(calendarDateOf('2026-02-29')).toBeNull()
    expect(calendarDateOf('20260228')).toBe('2026-02-28')
  })
})
