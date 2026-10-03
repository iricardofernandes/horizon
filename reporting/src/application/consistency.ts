import { businessDayOf } from '@horizon/contracts'
import { uuidv7 } from 'uuidv7'
import { z } from 'zod'
import {
  type Amounts,
  type ChainVerdict,
  type ConsistencyCheck,
  type ConsistencyRunOutcome,
  chainsCheck,
  compareAmounts,
  notApplicable,
  runOutcomeOf,
  totalsOf,
  unread,
} from '@/domain/consistency'
import type { Clock } from './ports/journal-store'
import type { OwnerReports } from './ports/report-store'

export interface ConsistencyRun {
  readonly runId: string
  readonly trigger: 'scheduled' | 'manual'
  readonly outcome: ConsistencyRunOutcome
  readonly checks: readonly ConsistencyCheck[]
  readonly pendingPostings: number | null
  readonly startedBy: string
  readonly startedAt: Date
  readonly finishedAt: Date
}

export abstract class ConsistencyStore {
  /** Keeps the run and its audit link, in one transaction. */
  abstract record(tenantId: string, run: ConsistencyRun, requestId: string | null): Promise<void>
  abstract list(tenantId: string, limit: number): Promise<ConsistencyRun[]>
}

/** Every module that keeps an audit log (Phase 68). */
export const AUDITED_MODULES = [
  'identity',
  'catalog',
  'sales',
  'financial',
  'treasury',
  'ledger',
  'procurement',
  'inventory',
  'fiscal',
  'crm',
  'reporting',
  'files',
] as const

const amount = z.string().regex(/^-?\d+$/)
const mappings = z.object({
  data: z.array(z.object({ role: z.string(), accountId: z.string() })),
})
const chart = z.object({
  data: z.array(z.object({ id: z.string(), currency: z.string(), balance: amount })),
})
const pending = z.object({ total: z.number().int().nonnegative() })
const summary = z.object({
  currencies: z.array(z.object({ currency: z.string(), outstanding: amount })),
})
const treasuryAccounts = z.object({
  data: z.array(z.object({ currency: z.string(), bookBalance: amount })),
})
const valuation = z.object({ totals: z.array(z.object({ currency: z.string(), value: amount })) })
const auditPage = z.object({
  data: z.array(z.unknown()),
  page: z.object({ nextCursor: z.string().optional() }),
  chain: z.object({ broken: z.array(z.number()) }),
})

type Read<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * Runs every consistency check for one tenant and keeps the run (ADR 0063).
 *
 * Owners are read now, through the gateway, with the given token: a person's on request,
 * the service identity's on a schedule. A figure that moved between two reads shows as a
 * difference, which a later run clears; the run records how many ledger facts were waiting
 * for a mapping, since those explain a control account that is short.
 */
export class RunConsistencyChecksUseCase {
  constructor(
    private readonly owners: OwnerReports,
    private readonly store: ConsistencyStore,
    private readonly clock: Clock,
    private readonly maxAuditPages = 500,
  ) {}

  async execute(request: {
    tenantId: string
    actor: string
    requestId: string | null
    trigger: 'scheduled' | 'manual'
    bearer: string
  }): Promise<ConsistencyRun> {
    const startedAt = this.clock.now()
    const today = businessDayOf(startedAt)
    const read = <T>(path: string, schema: z.ZodType<T>, query: Record<string, string> = {}) =>
      this.read(path, schema, query, request.bearer)
    const [roles, balances, waiting, receivables, payables, cash, stock] = await Promise.all([
      read('/ledger/mappings', mappings),
      read('/ledger/accounts', chart, { asOf: today }),
      read('/ledger/postings/pending', pending, { limit: '1' }),
      read('/financial/receivables/summary', summary),
      read('/financial/payables/summary', summary),
      read('/treasury/accounts', treasuryAccounts, { asOf: today }),
      read('/inventory/stock-valuation', valuation),
    ])
    const ledgerFor = (role: string): Read<Amounts | null> => {
      if (!roles.ok) return roles
      if (!balances.ok) return balances
      const accounts = new Set(
        roles.value.data.filter((row) => row.role === role).map((row) => row.accountId),
      )
      if (accounts.size === 0) return { ok: true, value: null }
      return {
        ok: true,
        value: totalsOf(
          balances.value.data
            .filter((row) => accounts.has(row.id))
            .map((row) => [row.currency, row.balance] as const),
        ),
      }
    }
    const control = (
      check: ConsistencyCheck['check'],
      role: string,
      owner: Read<Amounts>,
    ): ConsistencyCheck => {
      const ledger = ledgerFor(role)
      if (!owner.ok) return unread(check, owner.reason)
      if (!ledger.ok) return unread(check, ledger.reason)
      if (!ledger.value) return notApplicable(check, `no ledger account is mapped to ${role}`)
      return compareAmounts(check, owner.value, ledger.value)
    }
    const outstanding = (answer: Read<z.infer<typeof summary>>): Read<Amounts> =>
      answer.ok
        ? {
            ok: true,
            value: totalsOf(answer.value.currencies.map((row) => [row.currency, row.outstanding])),
          }
        : answer
    const checks: ConsistencyCheck[] = [
      control('receivables-control', 'receivables', outstanding(receivables)),
      control('payables-control', 'payables', outstanding(payables)),
      control(
        'cash-accounts',
        'cash',
        cash.ok
          ? {
              ok: true,
              value: totalsOf(cash.value.data.map((row) => [row.currency, row.bookBalance])),
            }
          : cash,
      ),
      control(
        'inventory-accounts',
        'inventory',
        stock.ok
          ? {
              ok: true,
              value: totalsOf(stock.value.totals.map((row) => [row.currency, row.value])),
            }
          : stock,
      ),
      chainsCheck(await this.chains(request.bearer)),
    ]
    const run: ConsistencyRun = {
      runId: uuidv7(),
      trigger: request.trigger,
      outcome: runOutcomeOf(checks),
      checks,
      pendingPostings: waiting.ok ? waiting.value.total : null,
      startedBy: request.actor,
      startedAt,
      finishedAt: this.clock.now(),
    }
    await this.store.record(request.tenantId, run, request.requestId)
    return run
  }

  /** Every page of every module's audit log, judged by the module itself (Phase 68). */
  private async chains(bearer: string): Promise<ChainVerdict[]> {
    return Promise.all(
      AUDITED_MODULES.map(async (module): Promise<ChainVerdict> => {
        const broken: number[] = []
        let checked = 0
        let cursor: string | undefined
        for (let pages = 0; pages < this.maxAuditPages; pages += 1) {
          const answer = await this.read(
            `/${module}/audit`,
            auditPage,
            { limit: '200', ...(cursor ? { cursor } : {}) },
            bearer,
          )
          if (!answer.ok) return { module, status: 'unread', checked, broken }
          checked += answer.value.data.length
          broken.push(...answer.value.chain.broken)
          cursor = answer.value.page.nextCursor
          if (!cursor) break
        }
        return { module, status: broken.length ? 'broken' : 'intact', checked, broken }
      }),
    )
  }

  private async read<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string>,
    bearer: string,
  ): Promise<Read<T>> {
    const answer = await this.owners.read(path, query, bearer)
    if (answer.status !== 'ok') return { ok: false, reason: `${path}: ${answer.status}` }
    const parsed = schema.safeParse(answer.body)
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, reason: `${path}: unreadable answer` }
  }
}
