import { z } from 'zod'
import type { CheckName, Figures } from '@/domain/reports'

const amount = z.string().regex(/^-?\d+$/)

const summary = z.object({
  currencies: z.array(z.object({ currency: z.string(), outstanding: amount })),
})
const accounts = z.object({ data: z.array(z.object({ id: z.string(), projectedBalance: amount })) })
const orders = z.object({
  data: z.array(
    z.object({ status: z.string(), currency: z.string(), count: z.number(), total: amount }),
  ),
})
const forecast = z.object({
  data: z.array(
    z.object({ month: z.string(), currency: z.string(), wonCount: z.number(), wonValue: amount }),
  ),
})

/** An owner answered with a body its own contract would not produce. */
export class UnreadableOwnerReport extends Error {
  constructor(check: CheckName) {
    super(`The owner report for ${check} could not be read`)
    this.name = 'UnreadableOwnerReport'
  }
}

/** Sums rows onto keys, since an owner may split a key across rows (statuses, groups). */
function sum(pairs: readonly [string, string | number][]): Figures {
  const totals = new Map<string, bigint>()
  for (const [key, value] of pairs) totals.set(key, (totals.get(key) ?? 0n) + BigInt(value))
  return Object.fromEntries([...totals].map(([key, value]) => [key, value.toString()]))
}

/** Purchase orders that still commit money: approved, received in full, or closed. */
const COMMITTED = new Set(['approved', 'received', 'closed'])

/** The owner's own figures for a check, read from its report's body. */
export function ownerFigures(check: CheckName, body: unknown): Figures {
  const parsed = parseFor(check, body)
  if (!parsed) throw new UnreadableOwnerReport(check)
  return parsed
}

function parseFor(check: CheckName, body: unknown): Figures | null {
  switch (check) {
    case 'receivables-outstanding':
    case 'payables-outstanding': {
      const read = summary.safeParse(body)
      return read.success
        ? sum(read.data.currencies.map((row) => [row.currency, row.outstanding]))
        : null
    }
    case 'account-balances': {
      const read = accounts.safeParse(body)
      return read.success ? sum(read.data.data.map((row) => [row.id, row.projectedBalance])) : null
    }
    case 'orders-confirmed':
    case 'orders-committed': {
      const read = orders.safeParse(body)
      if (!read.success) return null
      const counts = (status: string) =>
        check === 'orders-confirmed' ? status === 'confirmed' : COMMITTED.has(status)
      return sum(
        read.data.data
          .filter((row) => counts(row.status))
          .flatMap((row) => [
            [`${row.currency}:count`, row.count],
            [`${row.currency}:total`, row.total],
          ]),
      )
    }
    case 'won-by-month': {
      const read = forecast.safeParse(body)
      if (!read.success) return null
      return sum(
        read.data.data
          .filter((row) => row.wonCount > 0)
          .flatMap((row) => [
            [`${row.month}:${row.currency}:count`, row.wonCount],
            [`${row.month}:${row.currency}:value`, row.wonValue],
          ]),
      )
    }
  }
}
