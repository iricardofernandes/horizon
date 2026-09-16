'use client'

import { useNotice, useSession } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { ClassificationsView } from '@/features/classifications/classifications-view'
import type {
  Category,
  Dimension,
  PaymentMethod,
  PaymentTerm,
} from '@/features/classifications/types'
import { readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

async function load() {
  const [categories, dimensions, paymentMethods, paymentTerms] = await Promise.all([
    readPage<Category>('financial.categories', '/api/horizon/financial/categories'),
    readPage<Dimension>('financial.dimensions', '/api/horizon/financial/dimensions'),
    readPage<PaymentMethod>('financial.payment-methods', '/api/horizon/financial/payment-methods'),
    readPage<PaymentTerm>('financial.payment-terms', '/api/horizon/financial/payment-terms'),
  ])
  return { categories, dimensions, paymentMethods, paymentTerms }
}

export default function ClassificationsPage() {
  const session = useSession()
  const setNotice = useNotice()
  const state = useLoader(load)
  // Visibility only: Financial refuses the write regardless of what this decides (ADR 0045).
  const canManage = (session?.roles ?? []).some(
    (assignment) => assignment.module === 'financial' && assignment.role === 'admin',
  )
  return (
    <Resource state={state}>
      {(data) => (
        <ClassificationsView
          canManage={canManage}
          data={data}
          onChanged={state.reload}
          setNotice={setNotice}
        />
      )}
    </Resource>
  )
}
