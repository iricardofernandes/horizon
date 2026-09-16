'use client'

import { useNotice, useSession } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import type { Category, PaymentMethod, PaymentTerm } from '@/features/classifications/types'
import { ReceivablesView } from '@/features/receivables/receivables-view'
import {
  type Customer,
  localToday,
  type ReceivableRow,
  type ReceivablesSummary,
} from '@/features/receivables/types'
import { readJson, readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

async function load() {
  const today = localToday()
  const base = '/api/horizon/financial'
  const [receivables, summary, customers, categories, paymentMethods, paymentTerms] =
    await Promise.all([
      readPage<ReceivableRow>(
        'financial.receivables',
        `${base}/receivables?limit=100&today=${today}`,
      ),
      readJson<ReceivablesSummary>(
        'financial.receivables.summary',
        `${base}/receivables/summary?today=${today}`,
      ),
      readPage<Customer>('financial.receivables.customers', `${base}/receivables/customers`),
      readPage<Category>('financial.categories', `${base}/categories`),
      readPage<PaymentMethod>('financial.payment-methods', `${base}/payment-methods`),
      readPage<PaymentTerm>('financial.payment-terms', `${base}/payment-terms`),
    ])
  return { receivables, summary, customers, categories, paymentMethods, paymentTerms }
}

export default function ReceivablesPage() {
  const session = useSession()
  const setNotice = useNotice()
  const state = useLoader(load)
  // Visibility only: Financial refuses what a role does not permit (ADR 0023, ADR 0045).
  const roles = (session?.roles ?? []).filter((assignment) => assignment.module === 'financial')
  const abilities = {
    canRecord: roles.some((assignment) => ['admin', 'operator'].includes(assignment.role)),
    canReverse: roles.some((assignment) => assignment.role === 'admin'),
  }
  return (
    <Resource state={state}>
      {(data) => (
        <ReceivablesView
          abilities={abilities}
          data={data}
          onChanged={state.reload}
          setNotice={setNotice}
        />
      )}
    </Resource>
  )
}
