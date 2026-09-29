'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { type FormEvent, useId, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading } from '@/components/ui/headings'
import { apiError } from '@/lib/api'
import { ASSISTANT_NOTICE_VERSION, type AssistantStatus, budgetPercent } from '@/lib/assistant'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'

/**
 * The workspace's choice about the assistant (Phase 76, ADR 0069): the notice naming the
 * provider and what is sent, the switch only an owner turns on, and the monthly budget.
 */
export function AssistantSettingsView({
  status,
  isOwner,
  onChanged,
}: {
  status: AssistantStatus
  isOwner: boolean
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('assistantSettings')
  const format = useFormatter()
  const acceptId = useId()
  const budgetId = useId()
  const [accepted, setAccepted] = useState(false)
  const [budget, setBudget] = useState(String(status.budget.monthlyTokens))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function change(body: Record<string, unknown>) {
    setBusy(true)
    setError('')
    try {
      const response = await tracedFetch(
        'assistant.settings',
        '/api/horizon/agent/assistant/settings',
        {
          method: 'PUT',
          headers: jsonHeaders(),
          body: JSON.stringify(body),
        },
      )
      if (!response.ok) throw new Error(await apiError(response, t('failed')))
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }

  function saveBudget(event: FormEvent) {
    event.preventDefault()
    void change({ monthlyBudgetTokens: Number(budget) })
  }

  return (
    <section className="assistant-settings">
      <PageHeading eyebrow={t('eyebrow')} title={t('title')} copy={t('copy')} />
      <section className="panel">
        <header className="settings-section-heading">
          <div>
            <h2>{t('notice')}</h2>
            <p className="settings-card-caption">
              {t('noticeVersion', { version: ASSISTANT_NOTICE_VERSION })}
            </p>
          </div>
          <Badge
            label={status.enabled ? t('on') : t('off')}
            status={status.enabled ? 'active' : 'inactive'}
          />
        </header>
        <p>{t('noticeProvider', { provider: status.provider, model: status.model })}</p>
        <ul className="assistant-notice-list">
          <li>{t('sends.question')}</li>
          <li>{t('sends.conversation')}</li>
          <li>{t('sends.tools')}</li>
        </ul>
        <p>{t('noticeNever')}</p>
        {status.available ? null : <p role="note">{t('unavailable')}</p>}
        {status.enabled ? (
          <Button
            disabled={busy}
            onClick={() => void change({ enabled: false })}
            type="button"
            variant="ghost"
          >
            {t('turnOff')}
          </Button>
        ) : isOwner ? (
          <div className="assistant-accept">
            <input
              checked={accepted}
              id={acceptId}
              onChange={(event) => setAccepted(event.target.checked)}
              type="checkbox"
            />
            <label htmlFor={acceptId}>{t('accept')}</label>
            <Button
              disabled={busy || !accepted}
              onClick={() => void change({ enabled: true, acceptNotice: ASSISTANT_NOTICE_VERSION })}
              type="button"
            >
              {t('turnOn')}
            </Button>
          </div>
        ) : (
          <p className="settings-card-caption">{t('ownerOnly')}</p>
        )}
      </section>
      <section className="panel">
        <header className="settings-section-heading">
          <div>
            <h2>{t('budget')}</h2>
            <p className="settings-card-caption">
              {t('spent', {
                spent: format.number(status.budget.spentTokens),
                budget: format.number(status.budget.monthlyTokens),
                percent: budgetPercent(status),
                questions: status.budget.questions,
              })}
            </p>
          </div>
        </header>
        <form className="assistant-budget" onSubmit={saveBudget}>
          <label htmlFor={budgetId}>{t('budgetLabel')}</label>
          <input
            className="ui-input"
            id={budgetId}
            max={50_000_000}
            min={1000}
            onChange={(event) => setBudget(event.target.value)}
            step={1000}
            type="number"
            value={budget}
          />
          <Button disabled={busy} type="submit">
            {t('saveBudget')}
          </Button>
        </form>
      </section>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  )
}
