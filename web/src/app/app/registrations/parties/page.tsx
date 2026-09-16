'use client'

import { useNotice } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { PartiesView } from '@/features/parties/parties-view'
import type { Party } from '@/features/parties/party'
import { readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

function load() {
  return readPage<Party>('parties.list', '/api/horizon/parties/parties')
}

export default function PartiesPage() {
  const setNotice = useNotice()
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(parties) => (
        <PartiesView onChanged={state.reload} parties={parties} setNotice={setNotice} />
      )}
    </Resource>
  )
}
