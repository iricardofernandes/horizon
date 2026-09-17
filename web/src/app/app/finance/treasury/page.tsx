'use client'

import { useNotice, useSession } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { localToday } from '@/features/titles/types'
import { TreasuryView } from '@/features/treasury/treasury-view'
import { TREASURY_API, type TransferRow, type TreasuryAccount } from '@/features/treasury/types'
import { readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

async function load() {
  const [accounts, transfers] = await Promise.all([
    readPage<TreasuryAccount>('treasury.accounts', `${TREASURY_API}/accounts?asOf=${localToday()}`),
    readPage<TransferRow>('treasury.transfers', `${TREASURY_API}/transfers?limit=50`),
  ])
  return { accounts, transfers }
}

export default function TreasuryPage() {
  const session = useSession()
  const setNotice = useNotice()
  const state = useLoader(load)
  // Visibility only: Treasury refuses what a role does not permit (ADR 0023, ADR 0045).
  const roles = (session?.roles ?? [])
    .filter((assignment) => assignment.module === 'treasury')
    .map((assignment) => assignment.role)
  const admin = roles.includes('admin')
  const abilities = {
    canConfigure: admin,
    canRecord: admin || roles.includes('operator'),
    canReverse: admin,
  }
  return (
    <Resource state={state}>
      {(data) => (
        <TreasuryView
          abilities={abilities}
          data={data}
          onChanged={state.reload}
          setNotice={setNotice}
        />
      )}
    </Resource>
  )
}
