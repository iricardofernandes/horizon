'use client'

import { Robot } from '@phosphor-icons/react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'

/** Marks a record an agent drafted, and leads to the agent's call log (ADR 0066). */
export function AgentDraftBadge() {
  const t = useTranslations('agentDrafts')
  return (
    <Link
      className="agent-draft-badge"
      href="/app/developers/agent"
      onClick={(event) => event.stopPropagation()}
      title={t('badgeHint')}
    >
      <Robot aria-hidden="true" size={12} />
      {t('badge')}
    </Link>
  )
}

/** Shows only the records agents drafted; offered only when there are some. */
export function AgentDraftFilter({
  count,
  only,
  onChange,
}: {
  count: number
  only: boolean
  onChange: (only: boolean) => void
}) {
  const t = useTranslations('agentDrafts')
  if (!count) return null
  return (
    <button
      aria-pressed={only}
      className={`ui-button ui-button-secondary agent-draft-filter${only ? ' is-active' : ''}`}
      onClick={() => onChange(!only)}
      type="button"
    >
      <Robot aria-hidden="true" size={15} />
      {t('filter', { count })}
    </button>
  )
}
