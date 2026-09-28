'use client'

import { startRegistration } from '@simplewebauthn/browser'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { Empty, LoadingState, Notice } from '@/components/ui/state'
import type { FactorView, SessionView } from '@/lib/access'
import { apiError } from '@/lib/api'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime } from '@/lib/use-format'
import { useStepUp } from './step-up'
import { RecoveryCodes, TotpEnrollment } from './totp-enrollment'

const IDENTITY = '/api/horizon/identity'

type Factors = { factors: FactorView[]; recoveryCodesLeft: number }

async function post<T>(name: string, path: string, body?: unknown): Promise<T> {
  const response = await tracedFetch(name, `${IDENTITY}${path}`, {
    method: 'POST',
    headers: jsonHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(await apiError(response, 'failed'))
  return (await response.json()) as T
}

/**
 * The signed-in person's own security (Phase 67): second factors, recovery codes and
 * sessions. Removing a factor or making new codes asks for a step-up first.
 */
export function SecurityView() {
  const t = useTranslations('security')
  const [factors, setFactors] = useState<Factors | null>(null)
  const [sessions, setSessions] = useState<SessionView[] | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState('')
  const { run, dialog } = useStepUp()

  const load = useCallback(async () => {
    const [factorAnswer, sessionAnswer] = await Promise.all([
      tracedFetch('identity.mfa', `${IDENTITY}/me/mfa`),
      tracedFetch('identity.sessions', `${IDENTITY}/auth/sessions`),
    ])
    if (factorAnswer.ok) setFactors((await factorAnswer.json()) as Factors)
    if (sessionAnswer.ok)
      setSessions(((await sessionAnswer.json()) as { data: SessionView[] }).data)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function removeFactor(factor: FactorView) {
    const response = await run(() =>
      tracedFetch('identity.mfa.remove', `${IDENTITY}/me/mfa/factors/${factor.id}`, {
        method: 'DELETE',
      }),
    )
    setNotice(response.ok ? t('factorRemoved') : await apiError(response, t('failed')))
    await load()
  }

  async function regenerate() {
    const response = await run(() =>
      tracedFetch('identity.mfa.codes', `${IDENTITY}/me/mfa/recovery-codes`, { method: 'POST' }),
    )
    if (response.ok)
      setCodes(((await response.json()) as { recoveryCodes: string[] }).recoveryCodes)
    else setNotice(await apiError(response, t('failed')))
    await load()
  }

  async function addPasskey() {
    try {
      const options = await post<Parameters<typeof startRegistration>[0]['optionsJSON']>(
        'identity.passkey.options',
        '/me/mfa/passkeys/options',
      )
      const response = await startRegistration({ optionsJSON: options })
      const answer = await post<{ recoveryCodes: string[] | null }>(
        'identity.passkey.register',
        '/me/mfa/passkeys',
        {
          response,
          label: t('passkeyLabel'),
        },
      )
      if (answer.recoveryCodes) setCodes(answer.recoveryCodes)
      setNotice(t('passkeyAdded'))
    } catch {
      setNotice(t('passkeyFailed'))
    }
    await load()
  }

  async function endSession(session: SessionView) {
    const response = await tracedFetch(
      'identity.session.end',
      `${IDENTITY}/auth/sessions/${session.id}`,
      {
        method: 'DELETE',
      },
    )
    setNotice(response.ok ? t('sessionEnded') : await apiError(response, t('failed')))
    await load()
  }

  async function endOthers() {
    const answer = await post<{ ended: number }>(
      'identity.sessions.end-others',
      '/auth/sessions/revoke-others',
    )
    setNotice(t('othersEnded', { count: answer.ended }))
    await load()
  }

  return (
    <section>
      <PageHeading copy={t('copy')} eyebrow={t('eyebrow')} title={t('title')} />
      {notice ? <Notice copy={notice} /> : null}
      {codes ? <RecoveryCodes codes={codes} onClose={() => setCodes(null)} /> : null}
      <section className="panel security-panel">
        <PanelHeading copy={t('factorsCopy')} title={t('factorsTitle')} />
        {!factors ? (
          <LoadingState />
        ) : (
          <FactorList factors={factors} onRemove={(factor) => void removeFactor(factor)} />
        )}
        {adding ? (
          <TotpEnrollment
            confirm={async (factorId, code) => {
              const response = await tracedFetch(
                'identity.totp.confirm',
                `${IDENTITY}/me/mfa/totp/${factorId}/confirm`,
                {
                  method: 'POST',
                  headers: jsonHeaders(),
                  body: JSON.stringify({ code }),
                },
              )
              return response.ok
                ? ((await response.json()) as { recoveryCodes: string[] | null })
                : 'wrong'
            }}
            onDone={(recoveryCodes) => {
              setAdding(false)
              if (recoveryCodes) setCodes(recoveryCodes)
              setNotice(t('totpAdded'))
              void load()
            }}
            start={() => post('identity.totp.start', '/me/mfa/totp')}
          />
        ) : (
          <div className="dialog-actions">
            <Button onClick={() => setAdding(true)} type="button" variant="secondary">
              {t('addTotp')}
            </Button>
            <Button onClick={() => void addPasskey()} type="button" variant="secondary">
              {t('addPasskey')}
            </Button>
          </div>
        )}
        {factors?.factors.some((factor) => factor.active) ? (
          <p className="muted">
            {t('codesLeft', { count: factors.recoveryCodesLeft })}{' '}
            <Button onClick={() => void regenerate()} type="button" variant="ghost">
              {t('regenerate')}
            </Button>
          </p>
        ) : null}
      </section>
      <section className="panel security-panel">
        <PanelHeading copy={t('sessionsCopy')} title={t('sessionsTitle')} />
        {!sessions ? (
          <LoadingState />
        ) : (
          <SessionList onEnd={(session) => void endSession(session)} sessions={sessions} />
        )}
        {sessions && sessions.length > 1 ? (
          <Button onClick={() => void endOthers()} type="button" variant="secondary">
            {t('endOthers')}
          </Button>
        ) : null}
      </section>
      {dialog}
    </section>
  )
}

function FactorList({
  factors,
  onRemove,
}: {
  factors: Factors
  onRemove: (factor: FactorView) => void
}) {
  const t = useTranslations('security')
  const dateTime = useDateTime()
  const active = factors.factors.filter((factor) => factor.active)
  if (active.length === 0) return <Empty copy={t('noFactors')} />
  return (
    <ul className="security-list">
      {active.map((factor) => (
        <li key={factor.id}>
          <strong>{factor.kind === 'totp' ? t('kindTotp') : factor.label}</strong>
          <small>
            {factor.lastUsedAt
              ? t('lastUsed', { when: dateTime(factor.lastUsedAt) })
              : t('neverUsed')}
          </small>
          <Button onClick={() => onRemove(factor)} type="button" variant="ghost">
            {t('remove')}
          </Button>
        </li>
      ))}
    </ul>
  )
}

function SessionList({
  sessions,
  onEnd,
}: {
  sessions: SessionView[]
  onEnd: (session: SessionView) => void
}) {
  const t = useTranslations('security')
  const dateTime = useDateTime()
  if (sessions.length === 0) return <Empty copy={t('noSessions')} />
  return (
    <ul className="security-list">
      {sessions.map((session) => (
        <li key={session.id}>
          <strong>{session.device}</strong>
          <small>
            {t('sessionMeta', {
              network: session.ipPrefix ?? t('unknownNetwork'),
              since: dateTime(session.createdAt),
              last: dateTime(session.lastUsedAt),
            })}
          </small>
          {session.secondFactor ? <Badge label={t('withSecondFactor')} status="active" /> : null}
          {session.current ? (
            <Badge label={t('thisSession')} status="current" />
          ) : (
            <Button onClick={() => onEnd(session)} type="button" variant="ghost">
              {t('end')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}
