'use client'

import { Popover } from '@base-ui/react/popover'
import { ArrowsOutSimple, Plus, Sparkle, X } from '@phosphor-icons/react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SourcesPanel, TurnView } from '@/features/assistant/assistant-parts'
import { useAssistantThread } from '@/features/assistant/use-assistant-thread'
import { readJson } from '@/lib/api'
import { type AssistantStatus, budgetPercent, QUESTION_MAX, readinessOf } from '@/lib/assistant'

const STATUS = '/api/horizon/agent/assistant/status'

/** Reads whether the assistant can answer, the first time the chat is opened and after each turn. */
function useAssistantStatus(wanted: boolean) {
  const [status, setStatus] = useState<AssistantStatus | null>(null)
  const [failed, setFailed] = useState(false)

  async function refresh() {
    try {
      setStatus(await readJson<AssistantStatus>('assistant.status', STATUS))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once, when the chat is first opened.
  useEffect(() => {
    if (wanted && !status) void refresh()
  }, [wanted])

  return { status, failed, refresh }
}

/**
 * The assistant, a step away from any screen.
 *
 * A question usually comes up in the middle of other work, so the chat opens over the
 * screen the reader is on and leaves it where it was. The full screen keeps what a corner
 * cannot hold: the earlier conversations.
 */
export function AssistantDock() {
  const t = useTranslations('assistant')
  const inputId = useId()
  const [open, setOpen] = useState(false)
  const { status, failed, refresh } = useAssistantStatus(open)
  const thread = useAssistantThread(refresh)
  const readiness = status ? readinessOf(status) : null
  const ready = readiness === 'ready'
  const last = thread.turns.at(-1)

  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Trigger aria-label={t('dock')} className="assistant-fab" title={t('dock')}>
        <Sparkle aria-hidden="true" size={22} weight="fill" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          align="end"
          className="assistant-dock-positioner"
          collisionPadding={12}
          side="top"
          sideOffset={12}
        >
          <Popover.Popup className="assistant-dock">
            <header className="assistant-dock-header">
              <Popover.Title className="assistant-dock-title">{t('title')}</Popover.Title>
              <Button
                aria-label={t('newConversation')}
                className="icon-action"
                onClick={thread.startOver}
                title={t('newConversation')}
                type="button"
              >
                <Plus aria-hidden="true" size={16} />
              </Button>
              <Link
                aria-label={t('openFull')}
                className="ui-button ui-button-ghost icon-action"
                href="/app/assistant"
                onClick={() => setOpen(false)}
                title={t('openFull')}
              >
                <ArrowsOutSimple aria-hidden="true" size={16} />
              </Link>
              <Popover.Close
                aria-label={t('closeDock')}
                className="ui-button ui-button-ghost icon-action"
                title={t('closeDock')}
              >
                <X aria-hidden="true" size={16} />
              </Popover.Close>
            </header>

            <div aria-busy={thread.busy} className="assistant-dock-body" role="log">
              {failed ? (
                <div className="assistant-dock-failed" role="alert">
                  <span>{t('statusFailed')}</span>
                  <Button onClick={() => void refresh()} type="button">
                    {t('retry')}
                  </Button>
                </div>
              ) : null}
              {status && readiness !== 'ready' && readiness ? (
                <p className="assistant-dock-readiness" role="status">
                  {t(`readiness.${readiness}`, { provider: status.provider })}
                </p>
              ) : null}
              {ready && thread.turns.length === 0 ? <p className="muted">{t('empty')}</p> : null}
              {thread.turns.map((turn) => (
                <TurnView key={`${turn.askedAt}-${turn.question}`} turn={turn} />
              ))}
              {last && last.sources.length > 0 ? <SourcesPanel sources={last.sources} /> : null}
              {thread.problem ? <p role="alert">{thread.problem}</p> : null}
            </div>

            <form className="assistant-dock-form" onSubmit={(event) => void thread.ask(event)}>
              <label className="sr-only" htmlFor={inputId}>
                {t('question')}
              </label>
              <textarea
                className="ui-input"
                disabled={!ready || thread.busy}
                id={inputId}
                maxLength={QUESTION_MAX}
                onChange={(event) => thread.setQuestion(event.target.value)}
                placeholder={t('placeholder')}
                rows={2}
                value={thread.question}
              />
              <div className="assistant-dock-footer">
                <small className="muted">
                  {status
                    ? t('budget', {
                        percent: budgetPercent(status),
                        provider: status.provider,
                        model: status.model,
                      })
                    : null}
                </small>
                <Button
                  disabled={!ready || thread.busy || thread.question.trim().length < 2}
                  type="submit"
                  variant="primary"
                >
                  {thread.busy ? t('asking') : t('ask')}
                </Button>
              </div>
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
