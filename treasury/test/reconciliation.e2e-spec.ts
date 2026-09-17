import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ImportOutcome } from '@/application/use-cases/import-statements'
import { ImportStatementUseCase } from '@/application/use-cases/import-statements'
import { OpenAccountUseCase } from '@/application/use-cases/manage-accounts'
import { RecordEntryUseCase } from '@/application/use-cases/manage-journal'
import {
  ClosePeriodUseCase,
  ConfirmMatchUseCase,
  DismissSuggestionUseCase,
  IgnoreStatementLinesUseCase,
  ReopenPeriodUseCase,
  UndoReconciliationUseCase,
} from '@/application/use-cases/reconcile'
import { TreasuryDatabase } from '@/infrastructure/database/drizzle/treasury-database'
import { CsvStatementAdapter } from '@/infrastructure/statements/csv-adapter'
import { OfxStatementAdapter } from '@/infrastructure/statements/ofx-adapter'

const clock = { now: () => new Date() }
let database: TreasuryDatabase
let application: ReturnType<typeof postgres>

beforeAll(() => {
  database = new TreasuryDatabase({ url: process.env.DATABASE_URL ?? '' })
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), application?.end()])
})

function value<T>(result: { isLeft(): boolean; value: unknown }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

function ofx(transactions: readonly [string, string, string, string][], currency = 'BRL') {
  const lines = transactions
    .map(
      ([date, amount, fitid, name]) =>
        `<STMTTRN><TRNTYPE>OTHER<DTPOSTED>${date}<TRNAMT>${amount}<FITID>${fitid}<NAME>${name}</STMTTRN>`,
    )
    .join('\n')
  return `<OFX><CURDEF>${currency}<BANKTRANLIST>\n${lines}\n</BANKTRANLIST><LEDGERBAL><BALAMT>1000.00<DTASOF>20260930</LEDGERBAL></OFX>`
}

async function workspace() {
  const tenantId = randomUUID()
  const context = (key = randomUUID()) => ({
    tenantId,
    actor: 'clerk',
    requestId: null,
    idempotencyKey: key,
  })
  const accountId = value<{ id: string }>(
    await new OpenAccountUseCase(database, clock).execute({
      context: context(),
      account: {
        kind: 'bank',
        name: 'Checking',
        currency: 'BRL',
        bank: { bankCode: '341', branch: '0001', accountNumber: '12345-6' },
        openedOn: '2026-09-01',
        openingBalance: { amount: '100000', direction: 'inflow' },
      },
    }),
  ).id
  const record = async (
    direction: 'inflow' | 'outflow',
    amount: string,
    valueOn: string,
    memo?: string,
  ) =>
    value<{ id: string }>(
      await new RecordEntryUseCase(database, clock).execute({
        context: context(),
        accountId,
        entry: { direction, amount, currency: 'BRL', valueOn, memo },
      }),
    ).id
  const importer = new ImportStatementUseCase(database, clock, {
    ofx: new OfxStatementAdapter(),
    csv: new CsvStatementAdapter(),
  })
  const importFile = async (content: string, format: 'ofx' | 'csv' = 'ofx') =>
    importer.execute({
      context: context(),
      accountId,
      format,
      fileName: `statement.${format}`,
      content,
    })
  const view = (from = '2026-09-01', to = '2026-09-30') =>
    database.reconciliationWorkspace(tenantId, accountId, { from, to })
  const lineIds = async () =>
    Object.fromEntries((await view()).lines.map((line) => [line.description, line.id]))
  return { tenantId, accountId, context, record, importFile, view, lineIds }
}

describe('statement import', () => {
  it('stores each line once across reimports and overlapping files', async () => {
    const { importFile, view } = await workspace()
    const september = ofx([
      ['20260910', '-150.00', 'F1', 'BOLETO LUZ'],
      ['20260912', '300.00', 'F2', 'PIX ACME'],
    ])
    expect(value<ImportOutcome>(await importFile(september))).toMatchObject({
      imported: 2,
      duplicates: 0,
    })
    expect(value<ImportOutcome>(await importFile(september))).toMatchObject({
      imported: 0,
      alreadyImported: true,
    })
    const overlapping = ofx([
      ['20260912', '300.00', 'F2', 'PIX ACME'],
      ['20260915', '-20.00', 'F3', 'TARIFA'],
    ])
    expect(value<ImportOutcome>(await importFile(overlapping))).toMatchObject({
      imported: 1,
      duplicates: 1,
    })
    const csv =
      'Data;Histórico;Valor\n16/09/2026;Tarifa pacote;-12,90\n16/09/2026;Tarifa pacote;-12,90'
    expect(value<ImportOutcome>(await importFile(csv, 'csv'))).toMatchObject({ imported: 2 })
    expect(value<ImportOutcome>(await importFile(`${csv}\n`, 'csv'))).toMatchObject({
      imported: 0,
      duplicates: 2,
    })
    expect((await view()).lines).toHaveLength(5)
  })

  it('refuses a statement in another currency and keeps imported lines immutable', async () => {
    const { tenantId, importFile, lineIds } = await workspace()
    expect((await importFile(ofx([['20260910', '-1.00', 'X', 'USD']], 'USD'))).isLeft()).toBe(true)
    value(await importFile(ofx([['20260910', '-1.00', 'Y', 'TARIFA']])))
    const id = (await lineIds()).TARIFA ?? ''
    const asTenant = (statement: (sql: postgres.TransactionSql) => Promise<unknown>) =>
      application.begin(async (sql) => {
        await sql`select set_config('app.current_tenant', ${tenantId}, true)`
        return statement(sql)
      })
    await expect(
      asTenant((sql) => sql`update statement_lines set amount = 1 where id = ${id}`),
    ).rejects.toThrow(/permission denied/)
    await expect(
      asTenant((sql) => sql`delete from statement_lines where id = ${id}`),
    ).rejects.toThrow(/permission denied/)
  })
})

describe('reconciliation', () => {
  it('suggests, accepts, measures and undoes a one-to-one match', async () => {
    const { tenantId, accountId, context, record, importFile, view } = await workspace()
    const entry = await record('outflow', '15000', '2026-09-09', 'boleto luz setembro')
    value(await importFile(ofx([['20260910', '-150.00', 'F1', 'BOLETO LUZ']])))
    const before = await view()
    const [suggestion] = before.suggestions
    expect(suggestion).toMatchObject({ shape: '1:1', entryIds: [entry] })
    expect(suggestion?.reasons.map((reason) => reason.code)).toContain('amount-exact')
    const confirm = new ConfirmMatchUseCase(database, clock)
    const { id } = value<{ id: string }>(
      await confirm.execute({
        context: context(),
        accountId,
        statementLines: suggestion?.statementLineIds.map((lineId) => ({ id: lineId })) ?? [],
        entries: [{ id: entry }],
        suggestionKey: suggestion?.key,
      }),
    )
    const after = await view()
    expect(after.lines[0]?.status).toBe('matched')
    expect(after.suggestions).toEqual([])
    expect(await database.reconciliationMetrics(tenantId, accountId)).toMatchObject({
      accepted: 1,
      corrected: 0,
      acceptanceRate: 1,
    })
    const [account] = await database.listAccounts(tenantId, '2026-09-30')
    expect(account).toMatchObject({
      reconciledBalance: '-15000',
      statementBalance: '100000',
      statementBalanceOn: '2026-09-30',
    })

    value(
      await new UndoReconciliationUseCase(database, clock).execute({
        context: context(),
        reconciliationId: id,
        reason: 'Wrong bill',
      }),
    )
    expect((await view()).lines[0]?.status).toBe('unmatched')
    expect(
      (
        await new UndoReconciliationUseCase(database, clock).execute({
          context: context(),
          reconciliationId: id,
          reason: 'Again',
        })
      ).isLeft(),
    ).toBe(true)
  })

  it('matches one line to several entries, partially, or with an explicit adjustment', async () => {
    const { accountId, context, record, importFile, lineIds, view } = await workspace()
    const rent = await record('outflow', '60000', '2026-09-05')
    const cleaning = await record('outflow', '40000', '2026-09-05')
    const fee = await record('outflow', '950', '2026-09-20')
    value(
      await importFile(
        ofx([
          ['20260905', '-1000.00', 'B1', 'PAGAMENTOS LOTE'],
          ['20260920', '-10.00', 'B2', 'TARIFA DOC'],
          ['20260925', '500.00', 'B3', 'DEPOSITO'],
        ]),
      ),
    )
    const ids = await lineIds()
    const confirm = new ConfirmMatchUseCase(database, clock)
    value(
      await confirm.execute({
        context: context(),
        accountId,
        statementLines: [{ id: ids['PAGAMENTOS LOTE'] ?? '' }],
        entries: [{ id: rent }, { id: cleaning }],
      }),
    )

    const unbalanced = await confirm.execute({
      context: context(),
      accountId,
      statementLines: [{ id: ids['TARIFA DOC'] ?? '' }],
      entries: [{ id: fee }],
    })
    expect(unbalanced.isLeft() && unbalanced.value.message).toMatch(/apart/)
    const adjusted = value<{ adjustmentEntryId: string }>(
      await confirm.execute({
        context: context(),
        accountId,
        statementLines: [{ id: ids['TARIFA DOC'] ?? '' }],
        entries: [{ id: fee }],
        adjustment: { valueOn: '2026-09-20', memo: 'Tarifa maior que a prevista' },
      }),
    )
    expect(adjusted.adjustmentEntryId).toBeTruthy()

    const deposit = await record('inflow', '20000', '2026-09-25')
    value(
      await confirm.execute({
        context: context(),
        accountId,
        statementLines: [{ id: ids.DEPOSITO ?? '', amount: '20000' }],
        entries: [{ id: deposit }],
      }),
    )
    const current = await view()
    expect(current.lines.map((line) => [line.description, line.status, line.open])).toEqual([
      ['PAGAMENTOS LOTE', 'matched', '0'],
      ['TARIFA DOC', 'matched', '0'],
      ['DEPOSITO', 'partial', '30000'],
    ])
    expect(current.entries.find((entry) => entry.id === adjusted.adjustmentEntryId)).toMatchObject({
      amount: '-50',
      status: 'matched',
    })
  })

  it('keeps the period summary consistent with the book balances', async () => {
    const { accountId, context, record, importFile, lineIds, view } = await workspace()
    const early = await record('outflow', '5000', '2026-09-01')
    await record('outflow', '7000', '2026-09-14')
    value(
      await importFile(
        ofx([
          ['20260902', '-50.00', 'S1', 'CHEQUE'],
          ['20260915', '-12.00', 'S2', 'IOF'],
          ['20261002', '900.00', 'S3', 'FORA DO PERIODO'],
        ]),
      ),
    )
    const ids = await lineIds()
    value(
      await new ConfirmMatchUseCase(database, clock).execute({
        context: context(),
        accountId,
        statementLines: [{ id: ids.CHEQUE ?? '' }],
        entries: [{ id: early }],
      }),
    )
    value(
      await new IgnoreStatementLinesUseCase(database, clock).execute({
        context: context(),
        accountId,
        statementLines: [{ id: ids.IOF ?? '' }],
        reason: 'Imposto lançado na contabilidade',
      }),
    )
    const { summary } = await view('2026-09-02', '2026-09-30')
    const n = (text: string) => BigInt(text)
    expect(
      n(summary.bookOpening) +
        n(summary.statementTotal) -
        n(summary.ignoredTotal) -
        n(summary.unmatchedStatement) +
        n(summary.unmatchedEntries) +
        n(summary.crossPeriod),
    ).toBe(n(summary.bookClosing))
    expect(summary).toMatchObject({
      statementTotal: '-6200',
      ignoredTotal: '-1200',
      unmatchedEntries: '-7000',
      crossPeriod: '5000',
    })
  })

  it('closes a period only when every bank line is accounted for, freezing it until reopened', async () => {
    const { accountId, context, record, importFile, lineIds } = await workspace()
    const entry = await record('outflow', '1000', '2026-09-10')
    value(await importFile(ofx([['20260910', '-10.00', 'C1', 'TARIFA']])))
    const close = new ClosePeriodUseCase(database, clock)
    expect(
      (await close.execute({ context: context(), accountId, through: '2026-09-30' })).isLeft(),
    ).toBe(true)
    const ids = await lineIds()
    const { id } = value<{ id: string }>(
      await new ConfirmMatchUseCase(database, clock).execute({
        context: context(),
        accountId,
        statementLines: [{ id: ids.TARIFA ?? '' }],
        entries: [{ id: entry }],
      }),
    )
    value(await close.execute({ context: context(), accountId, through: '2026-09-30' }))
    const undo = new UndoReconciliationUseCase(database, clock)
    expect(
      (
        await undo.execute({ context: context(), reconciliationId: id, reason: 'Late correction' })
      ).isLeft(),
    ).toBe(true)
    value(
      await new ReopenPeriodUseCase(database, clock).execute({
        context: context(),
        accountId,
        reason: 'Bank corrected the fee',
      }),
    )
    value(
      await undo.execute({ context: context(), reconciliationId: id, reason: 'Late correction' }),
    )
  })

  it('never proposes a dismissed suggestion again and counts it', async () => {
    const { tenantId, accountId, record, importFile, view } = await workspace()
    await record('inflow', '30000', '2026-09-12')
    value(await importFile(ofx([['20260912', '300.00', 'D1', 'PIX']])))
    const [suggestion] = (await view()).suggestions
    value(
      await new DismissSuggestionUseCase(database, clock).execute({
        context: { tenantId, actor: 'clerk', requestId: null },
        accountId,
        key: suggestion?.key ?? '',
        score: suggestion?.score ?? 0,
      }),
    )
    expect((await view()).suggestions).toEqual([])
    expect(await database.reconciliationMetrics(tenantId, accountId)).toMatchObject({
      dismissed: 1,
      acceptanceRate: 0,
    })
  })

  it('refuses an unbalanced reconciliation written directly, and another tenant', async () => {
    const { tenantId, accountId, record, importFile, lineIds } = await workspace()
    const entry = await record('outflow', '999', '2026-09-10')
    value(await importFile(ofx([['20260910', '-10.00', 'U1', 'TARIFA']])))
    const line = (await lineIds()).TARIFA ?? ''
    const reconciliationId = randomUUID()
    await expect(
      application.begin(async (sql) => {
        await sql`select set_config('app.current_tenant', ${tenantId}, true)`
        await sql`insert into reconciliations (id, tenant_id, account_id, kind, origin, status, confirmed_by, confirmed_at)
          values (${reconciliationId}, ${tenantId}, ${accountId}, 'match', 'manual', 'active', 'x', now())`
        await sql`insert into reconciliation_items (tenant_id, reconciliation_id, statement_line_id, applied) values (${tenantId}, ${reconciliationId}, ${line}, -1000)`
        await sql`insert into reconciliation_items (tenant_id, reconciliation_id, entry_id, applied) values (${tenantId}, ${reconciliationId}, ${entry}, -999)`
      }),
    ).rejects.toThrow(/does not balance/)
    const intruder = randomUUID()
    const refused = await new ConfirmMatchUseCase(database, clock).execute({
      context: { tenantId: intruder, actor: 'x', requestId: null, idempotencyKey: randomUUID() },
      accountId,
      statementLines: [{ id: line }],
      entries: [{ id: entry }],
    })
    expect(refused.isLeft()).toBe(true)
  })
})
