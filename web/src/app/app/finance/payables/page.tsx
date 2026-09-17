'use client'

import { loadTitles, TitlesPage } from '@/features/titles/titles-page'

const load = () => loadTitles('payable')

export default function PayablesPage() {
  return <TitlesPage load={load} />
}
