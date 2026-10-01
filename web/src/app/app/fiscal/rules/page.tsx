'use client'

import { Resource } from '@/components/ui/resource'
import { RulesView } from '@/features/fiscal/rules/rules-view'
import type {
  CatalogPackage,
  RuleChangeEntry,
  RulesData,
  SupportRow,
  WorkspaceRule,
} from '@/features/fiscal/rules/types'
import { FISCAL_API } from '@/features/fiscal/types'
import { readJson } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

async function load(): Promise<RulesData> {
  const [packages, rules, changes, matrix] = await Promise.all([
    readJson<{ data: CatalogPackage[] }>(
      'fiscal.catalog.packages',
      `${FISCAL_API}/catalog/packages`,
    ),
    readJson<{ data: WorkspaceRule[] }>('fiscal.rules', `${FISCAL_API}/rules`),
    readJson<{ data: RuleChangeEntry[] }>('fiscal.rule-changes', `${FISCAL_API}/rule-changes`),
    readJson<{ rows: SupportRow[] }>('fiscal.support.matrix', `${FISCAL_API}/support`),
  ])
  return { packages: packages.data, rules: rules.data, changes: changes.data, matrix: matrix.rows }
}

export default function FiscalRulesPage() {
  const state = useLoader(load)
  return (
    <Resource state={state}>{(data) => <RulesView data={data} reload={state.reload} />}</Resource>
  )
}
