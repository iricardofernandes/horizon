'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { RecoveryCodes, TotpEnrollment, type TotpStart } from '@/features/security/totp-enrollment'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'

async function enrollment<T>(body: unknown): Promise<{ ok: boolean; body: T }> {
  const response = await tracedFetch('session.enrollment', '/api/session/enrollment', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  })
  return { ok: response.ok, body: (await response.json().catch(() => ({}))) as T }
}

/**
 * The workspace requires a second factor and its grace period ended (Phase 67): enroll an
 * authenticator app, keep the recovery codes, and sign in again.
 */
export default function EnrollPage() {
  const t = useTranslations('enroll')
  const router = useRouter()
  const [codes, setCodes] = useState<string[] | null>(null)
  const [done, setDone] = useState(false)

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-card">
          <div>
            <p className="eyebrow">{t('eyebrow')}</p>
            <h2>{t('title')}</h2>
            <p className="muted">{t('copy')}</p>
          </div>
          {done ? null : (
            <TotpEnrollment
              confirm={async (factorId, code) => {
                const answer = await enrollment<{ recoveryCodes: string[] | null }>({
                  action: 'confirm',
                  factorId,
                  code,
                })
                return answer.ok ? answer.body : 'wrong'
              }}
              onDone={(recoveryCodes) => {
                setCodes(recoveryCodes)
                setDone(true)
              }}
              start={async () => {
                const answer = await enrollment<TotpStart>({ action: 'start' })
                if (!answer.ok) throw new Error('expired')
                return answer.body
              }}
            />
          )}
          {codes ? <RecoveryCodes codes={codes} onClose={() => setCodes(null)} /> : null}
          {done && !codes ? (
            <Button
              className="wide"
              onClick={() => router.replace('/login')}
              type="button"
              variant="primary"
            >
              {t('signInAgain')}
            </Button>
          ) : null}
        </div>
      </section>
    </main>
  )
}
