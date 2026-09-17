'use client'

import { useNotice, useSession } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import type { Category, PaymentMethod, PaymentTerm } from '@/features/classifications/types'
import { readJson, readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'
import { TitlesView } from './titles-view'
import {
  type ApprovalPolicy,
  apiBaseOf,
  type Counterparty,
  type Direction,
  localToday,
  type TitleRow,
  type TitlesData,
  type TitlesSummary,
} from './types'

/** Everything one direction's screen reads, in parallel. */
export async function loadTitles(direction: Direction): Promise<TitlesData> {
  const today = localToday()
  const base = apiBaseOf(direction)
  const financial = '/api/horizon/financial'
  const [titles, summary, counterparties, categories, paymentMethods, paymentTerms, policies] =
    await Promise.all([
      readPage<TitleRow>(`financial.${direction}s`, `${base}?limit=100&today=${today}`),
      readJson<TitlesSummary>(`financial.${direction}s.summary`, `${base}/summary?today=${today}`),
      readPage<Counterparty>(`financial.${direction}s.counterparties`, `${base}/counterparties`),
      readPage<Category>('financial.categories', `${financial}/categories`),
      readPage<PaymentMethod>('financial.payment-methods', `${financial}/payment-methods`),
      readPage<PaymentTerm>('financial.payment-terms', `${financial}/payment-terms`),
      direction === 'payable'
        ? readPage<ApprovalPolicy>('financial.approval-policies', `${base}/approval-policies`)
        : Promise.resolve([]),
    ])
  return {
    direction,
    titles,
    summary,
    counterparties,
    categories,
    paymentMethods,
    paymentTerms,
    approvalPolicies: policies,
    treasuryAccounts: await treasuryAccounts(),
  }
}

/** Treasury is another module: a reader without a treasury role simply gets no accounts. */
async function treasuryAccounts(): Promise<TitlesData['treasuryAccounts']> {
  try {
    const accounts = await readPage<{
      id: string
      name: string
      currency: string
      active: boolean
    }>('treasury.accounts', '/api/horizon/treasury/accounts')
    return accounts.filter((account) => account.active)
  } catch {
    return []
  }
}

/** `load` must be declared at module scope by the route, so it stays stable. */
export function TitlesPage({ load }: { load: () => Promise<TitlesData> }) {
  const session = useSession()
  const setNotice = useNotice()
  const state = useLoader(load)
  // Visibility only: Financial refuses what a role does not permit (ADR 0023, ADR 0045).
  const roles = (session?.roles ?? [])
    .filter((assignment) => assignment.module === 'financial')
    .map((assignment) => assignment.role)
  const admin = roles.includes('admin')
  const abilities = {
    canRecord: admin || roles.includes('operator'),
    canReverse: admin,
    canApprove: admin,
    canConfigure: admin,
    userId: session?.id ?? null,
  }
  return (
    <Resource state={state}>
      {(data) => (
        <TitlesView
          abilities={abilities}
          data={data}
          onChanged={state.reload}
          setNotice={setNotice}
        />
      )}
    </Resource>
  )
}
