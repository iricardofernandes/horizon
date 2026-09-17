'use client'

import { useNotice, useSession } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { ReconciliationView } from '@/features/reconciliation/reconciliation-view'
import { localToday } from '@/features/titles/types'
import { TREASURY_API, type TreasuryAccount } from '@/features/treasury/types'
import { readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

function load() {
  return readPage<TreasuryAccount>(
    'treasury.accounts',
    `${TREASURY_API}/accounts?asOf=${localToday()}`,
  )
}

export default function ReconciliationPage() {
  const session = useSession()
  const setNotice = useNotice()
  const state = useLoader(load)
  // Visibility only: Treasury refuses what a role does not permit (ADR 0023, ADR 0045).
  const roles = (session?.roles ?? [])
    .filter((assignment) => assignment.module === 'treasury')
    .map((assignment) => assignment.role)
  const admin = roles.includes('admin')
  const abilities = {
    canRecord: admin || roles.includes('operator'),
    canUndo: admin,
    canClose: admin,
  }
  return (
    <Resource state={state}>
      {(accounts) => (
        <ReconciliationView
          abilities={abilities}
          accounts={accounts.filter((account) => account.active)}
          setNotice={setNotice}
        />
      )}
    </Resource>
  )
}
