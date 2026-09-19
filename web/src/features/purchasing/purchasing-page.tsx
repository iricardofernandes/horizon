'use client'

import { useSession } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { readJson } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'
import { PurchasingView, type Screen } from './purchasing-view'
import { type OrderRow, PROCUREMENT_API, type PurchasingData, type RequisitionRow } from './types'

/**
 * Every purchasing screen reads the same two collections.
 *
 * The boards and the inbox are three views of one set of documents, so reading them once and
 * filtering in the browser is what keeps the inbox and the board from ever disagreeing about
 * what is waiting.
 */
export async function loadPurchasing(): Promise<PurchasingData> {
  const [requisitions, orders] = await Promise.all([
    readJson<{ data: RequisitionRow[] }>(
      'procurement.requisitions',
      `${PROCUREMENT_API}/requisitions?limit=200`,
    ),
    readJson<{ data: OrderRow[] }>('procurement.orders', `${PROCUREMENT_API}/orders?limit=200`),
  ])
  return { requisitions: requisitions.data, orders: orders.data }
}

export function PurchasingPage({ screen }: { screen: Screen }) {
  const session = useSession()
  const state = useLoader(loadPurchasing)
  // Visibility only: Procurement refuses what a role does not permit (ADR 0023, ADR 0045).
  const roles = (session?.roles ?? [])
    .filter((assignment) => assignment.module === 'procurement')
    .map((assignment) => assignment.role)
  const admin = roles.includes('admin')
  const abilities = {
    canWrite: admin || roles.includes('buyer'),
    canCommit: admin || roles.includes('buyer'),
    canDecide: admin || roles.includes('approver'),
    userId: session?.id ?? null,
  }
  return (
    <Resource state={state}>
      {(data) => (
        <PurchasingView
          abilities={abilities}
          data={data}
          onChanged={state.reload}
          screen={screen}
        />
      )}
    </Resource>
  )
}
