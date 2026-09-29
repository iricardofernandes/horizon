'use client'

import { ChatCircleText, Plus } from '@phosphor-icons/react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PageHeading } from '@/components/ui/headings'
import {
  type AssistantAnswer,
  type AssistantStatus,
  type AssistantTurn,
  budgetPercent,
  type ConversationSummary,
  QUESTION_MAX,
  readinessOf,
  refusalOf,
  turnOf,
} from '@/lib/assistant'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { SourcesPanel, TurnView } from './assistant-parts'

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
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [turns, setTurns] = useState<AssistantTurn[]>([])
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const readiness = readinessOf(state.status)

  async function open(id: string) {
    setProblem(null)
    const response = await tracedFetch(
      'assistant.conversation',
      `/api/horizon/agent/assistant/conversations/${id}`,
      { cache: 'no-store' },
    )
    if (!response.ok) {
      setProblem(t('refused.failed'))
      return
    }
    setConversationId(id)
    setTurns(((await response.json()) as { turns: AssistantTurn[] }).turns)
  }

  function startOver() {
    setConversationId(null)
    setTurns([])
    setProblem(null)
  }

  async function ask(event: FormEvent) {
    event.preventDefault()
    const text = question.trim()
    if (text.length < 2 || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const response = await tracedFetch(
        'assistant.ask',
        '/api/horizon/agent/assistant/questions',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ question: text, ...(conversationId ? { conversationId } : {}) }),
        },
      )
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { code?: unknown }
        setProblem(t(`refused.${refusalOf(body.code)}`))
        return
      }
      const answer = (await response.json()) as AssistantAnswer
      setConversationId(answer.conversationId)
      setTurns((current) => [...current, turnOf(text, answer, new Date())])
      setQuestion('')
    } finally {
      setBusy(false)
      await onChanged()
    }
  }

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
