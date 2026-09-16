'use client'

import { useNotice } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import type { Party } from '@/features/parties/party'
import { CustomersView } from '@/features/sales/customers-view'
import { readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

function load() {
  return readPage<Party>('parties.customers', '/api/horizon/parties/parties?role=customer')
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
