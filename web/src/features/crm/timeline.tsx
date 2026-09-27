'use client'

import { useTranslations } from 'next-intl'
import { Empty } from '@/components/ui/state'
import { useDateTime } from '@/lib/use-format'
import type { CrmDirectory } from './crm-data'
import { personLabel, type TimelineEntry } from './types'

/**
 * What happened around an account or an opportunity, newest first (Phase 57): activities,
 * tasks, notes and the opportunity's own history. A record whose account was erased has no
 * text left, and says so.
 */
export function Timeline({
  entries,
  directory,
}: {
  entries: readonly TimelineEntry[]
  directory: CrmDirectory
}) {
  const t = useTranslations('crm')
  const when = useDateTime()
  if (entries.length === 0) return <Empty copy={t('timeline.empty')} />
  return (
    <ol className="crm-timeline">
      {entries.map((entry) => (
        <li className={`crm-timeline-entry crm-timeline-${entry.kind}`} key={keyOf(entry)}>
          <span className="crm-timeline-when">{when(entry.at)}</span>
          <TimelineLine directory={directory} entry={entry} />
        </li>
      ))}
    </ol>
  )
}

/** A record's own id, or an opportunity fact's place in its history. */
function keyOf(entry: TimelineEntry): string {
  const { record } = entry
  const id = record.id ?? `${String(record.opportunityId)}:${String(record.sequence)}`
  return `${entry.kind}-${String(id)}`
}

function TimelineLine({ entry, directory }: { entry: TimelineEntry; directory: CrmDirectory }) {
  const t = useTranslations('crm')
  const record = entry.record
  const text = (value: unknown) => (typeof value === 'string' ? value : t('timeline.erasedText'))
  switch (entry.kind) {
    case 'activity':
      return (
        <div>
          <strong>
            {t(`activityKind.${String(record.kind)}`)} · {text(record.title)}
          </strong>
          {record.summary ? <p className="crm-timeline-text">{text(record.summary)}</p> : null}
        </div>
      )
    case 'task':
      return (
        <div>
          <strong>
            {t('timeline.task')} · {text(record.title)}
          </strong>
          <p className="crm-timeline-text">
            {t(`taskStatus.${String(record.status)}`)} ·{' '}
            {personLabel(directory.names, String(record.assigneeId), t('noOwner'))}
          </p>
        </div>
      )
    case 'note':
      return (
        <div>
          <strong>
            {t('timeline.note')}
            {Number(record.revisionCount) > 1
              ? ` · ${t('timeline.revisions', { count: Number(record.revisionCount) })}`
              : ''}
          </strong>
          <p className="crm-timeline-text">{text(record.body)}</p>
        </div>
      )
    default: {
      const fact = (record.fact ?? {}) as Record<string, unknown>
      const actor = String(record.actor ?? '')
      // A system actor (`sales:quote-accepted`) is a process, not a person.
      const by = actor.includes(':')
        ? t('system')
        : personLabel(directory.names, actor, t('system'))
      return (
        <div>
          <strong>{t(`fact.${String(fact.type)}`)}</strong>
          <p className="crm-timeline-text">{by}</p>
        </div>
      )
    }
  }
}
