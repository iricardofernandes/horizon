'use client'

import { ArrowSquareOut, FileText, Table } from '@phosphor-icons/react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { type AssistantSource, type AssistantTurn, sourcesBeside } from '@/lib/assistant'

/** One question and what was answered: each statement with the sources it cites. */
export function TurnView({ turn }: { turn: AssistantTurn }) {
  const t = useTranslations('assistant')
  return (
    <article className="assistant-turn">
      <p className="assistant-question">{turn.question}</p>
      {turn.outcome !== 'answered' ? (
        <p className="assistant-stopped" role="status">
          {t(`stopped.${turn.outcome}`)}
        </p>
      ) : null}
      <ul className="assistant-statements">
        {turn.statements.map((statement) => (
          <li
            className={statement.found ? '' : 'not-found'}
            key={`${statement.text}-${statement.sources.join(',')}`}
          >
            <span className={statement.found ? undefined : 'assistant-unsupported'}>
              {statement.text}
            </span>
            {statement.found ? (
              statement.sources.map((id) => (
                <a className="assistant-cite" href={`#source-${id}`} key={id}>
                  {id}
                </a>
              ))
            ) : (
              <Badge label={t('notFound')} status="inactive" />
            )}
          </li>
        ))}
      </ul>
    </article>
  )
}

/** What the tools answered for the last turn, cited first, each linking to its record. */
export function SourcesPanel({ sources }: { sources: readonly AssistantSource[] }) {
  const t = useTranslations('assistant')
  const records = useTranslations('palette.recordTypes')
  return (
    <aside aria-label={t('sources')} className="panel assistant-sources">
      <h2>{t('sources')}</h2>
      {sources.length === 0 ? <p className="muted">{t('noSources')}</p> : null}
      <ol>
        {sourcesBeside(sources).map((source) => (
          <li className={source.cited ? 'cited' : ''} id={`source-${source.id}`} key={source.id}>
            <header>
              <strong>{source.id}</strong>
              {source.kind === 'document' ? (
                <>
                  <FileText aria-hidden="true" size={16} />
                  <span>
                    {records(source.record.recordType)} ·{' '}
                    {t('excerpt', { chunk: source.position.chunk, of: source.position.of })}
                  </span>
                </>
              ) : (
                <>
                  <Table aria-hidden="true" size={16} />
                  <span>
                    <code>{source.tool}</code>
                    {source.rows === null ? '' : ` · ${t('rows', { rows: source.rows })}`}
                  </span>
                </>
              )}
              {source.cited ? null : <small>{t('notCited')}</small>}
            </header>
            {source.kind === 'document' ? <blockquote>{source.excerpt}</blockquote> : null}
            <Link href={source.screen}>
              {t('openRecord')} <ArrowSquareOut aria-hidden="true" size={14} />
            </Link>
          </li>
        ))}
      </ol>
    </aside>
  )
}
