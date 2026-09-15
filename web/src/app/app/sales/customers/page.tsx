'use client'

import { useNotice } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { type Customer, CustomersView } from '@/features/sales/customers-view'
import { readJson } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

function load() {
  return readJson<Customer[]>('sales.customers', '/api/horizon/sales/customers')
}

export default function CustomersPage() {
  const setNotice = useNotice()
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(customers) => (
        <CustomersView customers={customers} onChanged={state.reload} setNotice={setNotice} />
      )}
    </Resource>
  )
}
