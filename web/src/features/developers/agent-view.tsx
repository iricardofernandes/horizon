'use client'

import { Check, Copy, Robot } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading } from '@/components/ui/headings'
import { type AgentCall, type AgentSettings, agentEndpoint } from '@/lib/agent'
import { apiError } from '@/lib/api'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime } from '@/lib/use-format'

const API_URL = process.env.NEXT_PUBLIC_HORIZON_API_URL ?? 'http://localhost:8000'

export type AgentState = {
  tenantId: string
  /** Null when the person may not see the switch (only an Identity owner or admin may). */
  settings: AgentSettings | null
  calls: AgentCall[] | null
  chain: 'intact' | 'broken' | null
}

export function AgentView({
  state,
  onChanged,
}: {
  state: AgentState
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('agent')
  const dateTime = useDateTime()
  return (
    <section className="agent-view">
      <PageHeading eyebrow={t('eyebrow')} title={t('title')} copy={t('copy')} />
      <section className="panel api-key-panel">
        <header className="settings-section-heading">
          <div>
            <h2>{t('endpoint')}</h2>
            <p className="settings-card-caption">{t('endpointCopy')}</p>
          </div>
        </header>
        <Endpoint url={agentEndpoint(API_URL, state.tenantId)} />
      </section>
      <section className="panel api-key-panel">
        <header className="settings-section-heading">
          <div>
            <h2>{t('access')}</h2>
            <p className="settings-card-caption">{t('accessCopy')}</p>
          </div>
          {state.settings ? <AccessSwitch settings={state.settings} onChanged={onChanged} /> : null}
        </header>
        {state.settings ? (
          <Badge
            label={state.settings.enabled ? t('accessOn') : t('accessOff')}
            status={state.settings.enabled ? 'active' : 'inactive'}
          />
        ) : (
          <p className="settings-card-caption">{t('accessAdminsOnly')}</p>
        )}
      </section>
      <section className="panel">
        <header className="settings-section-heading">
          <div>
            <h2>{t('calls')}</h2>
            <p className="settings-card-caption">{t('callsCopy')}</p>
          </div>
          {state.chain ? (
            <Badge
              label={state.chain === 'intact' ? t('chainIntact') : t('chainBroken')}
              status={state.chain === 'intact' ? 'active' : 'rejected'}
            />
          ) : null}
        </header>
        {state.calls === null ? (
          <p className="settings-card-caption">{t('callsAdminsOnly')}</p>
        ) : state.calls.length === 0 ? (
          <div className="catalog-empty">
            <Robot aria-hidden="true" size={20} />
            <strong>{t('emptyTitle')}</strong>
            <p>{t('emptyCopy')}</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('when')}</th>
                  <th scope="col">{t('key')}</th>
                  <th scope="col">{t('tool')}</th>
                  <th scope="col">{t('outcome')}</th>
                  <th scope="col">{t('rows')}</th>
                </tr>
              </thead>
              <tbody>
                {state.calls.map((call) => (
                  <tr key={call.sequence}>
                    <td>{dateTime(call.occurredAt)}</td>
                    <td>
                      <code>{call.keyId.slice(0, 8)}</code>
                    </td>
                    <td>
                      <code>{call.tool}</code>
                    </td>
                    <td>
                      {call.outcome}
                      {call.status ? ` (${call.status})` : ''}
                    </td>
                    <td>
                      {call.rows ?? '—'}
                      {call.truncated ? ` · ${t('truncated')}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  )
}

function Endpoint({ url }: { url: string }) {
  const t = useTranslations('agent')
  const [copied, setCopied] = useState(false)
  return (
    <div className="agent-endpoint">
      <code>{url}</code>
      <Button
        onClick={async () => {
          await navigator.clipboard.writeText(url)
          setCopied(true)
        }}
        type="button"
        variant="secondary"
      >
        {copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}
        {copied ? t('copied') : t('copyEndpoint')}
      </Button>
    </div>
  )
}

function AccessSwitch({
  settings,
  onChanged,
}: {
  settings: AgentSettings
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('agent')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function toggle() {
    setBusy(true)
    setError('')
    const response = await tracedFetch('agent.settings.update', '/api/horizon/agent/settings', {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ enabled: !settings.enabled }),
    })
    if (!response.ok) setError(await apiError(response, t('switchFailed')))
    else await onChanged()
    setBusy(false)
  }
  return (
    <div className="row-actions">
      <Button
        disabled={busy}
        onClick={toggle}
        type="button"
        variant={settings.enabled ? 'secondary' : 'primary'}
      >
        {settings.enabled ? t('turnOff') : t('turnOn')}
      </Button>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
