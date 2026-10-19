'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { type AssistantAnswer, type AssistantTurn, refusalOf, turnOf } from '@/lib/assistant'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'

export type AssistantThread = {
  conversationId: string | null
  turns: AssistantTurn[]
  question: string
  setQuestion: (value: string) => void
  busy: boolean
  problem: string | null
  open: (id: string) => Promise<void>
  startOver: () => void
  ask: (event: FormEvent) => Promise<void>
}

/**
 * One conversation with the assistant: what was asked, what was answered and what stopped
 * it. The screen and the docked chat are two views of the same exchange, so the exchange
 * is written once (Phase 76).
 */
export function useAssistantThread(onChanged?: () => Promise<void> | void): AssistantThread {
  const t = useTranslations('assistant')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [turns, setTurns] = useState<AssistantTurn[]>([])
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

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
      await onChanged?.()
    }
  }

  return { conversationId, turns, question, setQuestion, busy, problem, open, startOver, ask }
}
