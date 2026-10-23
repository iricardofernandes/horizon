'use client'

import { ChatCircleText, Plus } from '@phosphor-icons/react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { PageHeading } from '@/components/ui/headings'
import {
  type AssistantStatus,
  budgetPercent,
  type ConversationSummary,
  QUESTION_MAX,
  readinessOf,
} from '@/lib/assistant'
import { SourcesPanel, TurnView } from './assistant-parts'
import { useAssistantThread } from './use-assistant-thread'

export type AssistantState = {
  status: AssistantStatus
  conversations: ConversationSummary[]
  /** Whether the person may change the workspace's settings (an Identity owner or admin). */
  canManage: boolean
}

/**
 * The in-app assistant (Phase 76): questions answered from what the person may read, every
 * statement with its sources beside it, and a plain word when it is off or out of budget.
 */
export function AssistantView({
  state,
  onChanged,
}: {
  state: AssistantState
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('assistant')
  const inputId = useId()
  const { conversationId, turns, question, setQuestion, busy, problem, open, startOver, ask } =
    useAssistantThread(onChanged)
  const readiness = readinessOf(state.status)

  const last = turns.at(-1)
  return (
    <section className="assistant-view">
      <PageHeading eyebrow={t('eyebrow')} title={t('title')} copy={t('copy')} />
      {readiness === 'ready' ? null : (
        <p className="panel assistant-readiness" role="status">
          {t(`readiness.${readiness}`, { provider: state.status.provider })}{' '}
          {state.canManage ? (
            <Link href="/app/administration/assistant">{t('toSettings')}</Link>
          ) : null}
        </p>
      )}
      <div className="assistant-layout">
        <nav aria-label={t('conversations')} className="panel assistant-conversations">
          <Button onClick={startOver} type="button" variant="ghost">
            <Plus aria-hidden="true" /> {t('newConversation')}
          </Button>
          {state.conversations.length === 0 ? (
            <p className="muted">{t('noConversations')}</p>
          ) : null}
          <ul>
            {state.conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  aria-current={conversation.id === conversationId ? 'true' : undefined}
                  className="crm-link-button"
                  onClick={() => void open(conversation.id)}
                  type="button"
                >
                  <ChatCircleText aria-hidden="true" size={16} /> {conversation.title}
                </button>
              </li>
            ))}
          </ul>
          <p className="muted">{t('kept')}</p>
        </nav>
        <div className="panel assistant-thread" aria-busy={busy}>
          {turns.length === 0 ? <p className="muted">{t('empty')}</p> : null}
          {turns.map((turn) => (
            <TurnView key={`${turn.askedAt}-${turn.question}`} turn={turn} />
          ))}
          {problem ? <p role="alert">{problem}</p> : null}
          <form className="assistant-form" onSubmit={(event) => void ask(event)}>
            <label htmlFor={inputId}>{t('question')}</label>
            <textarea
              className="ui-input"
              disabled={readiness !== 'ready' || busy}
              id={inputId}
              maxLength={QUESTION_MAX}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={t('placeholder')}
              rows={3}
              value={question}
            />
            <div className="assistant-form-footer">
              <small className="muted">
                {t('budget', {
                  percent: budgetPercent(state.status),
                  provider: state.status.provider,
                  model: state.status.model,
                })}
              </small>
              <Button
                disabled={readiness !== 'ready' || busy || question.trim().length < 2}
                type="submit"
              >
                {busy ? t('asking') : t('ask')}
              </Button>
            </div>
          </form>
        </div>
        <SourcesPanel sources={last?.sources ?? []} />
      </div>
    </section>
  )
}
