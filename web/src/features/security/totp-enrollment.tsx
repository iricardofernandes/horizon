'use client'

import { useTranslations } from 'next-intl'
import QRCode from 'qrcode'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { cleanCode, groupedSecret } from '@/lib/access'

export type TotpStart = { factorId: string; secret: string; otpauthUri: string }

type Props = {
  start: () => Promise<TotpStart>
  confirm: (factorId: string, code: string) => Promise<{ recoveryCodes: string[] | null } | 'wrong'>
  onDone: (recoveryCodes: string[] | null) => void
}

/**
 * Adding an authenticator app (RFC 6238): a QR code to scan, the secret to type if the
 * camera cannot, and the first code to prove the app holds it.
 */
export function TotpEnrollment({ start, confirm, onDone }: Props) {
  const t = useTranslations('security.totp')
  const [started, setStarted] = useState<(TotpStart & { qr: string }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function begin() {
    setBusy(true)
    setError('')
    try {
      const next = await start()
      setStarted({
        ...next,
        qr: await QRCode.toDataURL(next.otpauthUri, { margin: 1, width: 200 }),
      })
    } catch {
      setError(t('failed'))
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!started) return
    const code = cleanCode('totp', String(new FormData(event.currentTarget).get('code') ?? ''))
    setBusy(true)
    setError('')
    const outcome = await confirm(started.factorId, code).catch(() => 'wrong' as const)
    setBusy(false)
    if (outcome === 'wrong') {
      setError(t('wrongCode'))
      return
    }
    onDone(outcome.recoveryCodes)
  }

  if (!started)
    return (
      <div className="totp-enrollment">
        <Button disabled={busy} onClick={() => void begin()} type="button" variant="primary">
          {t('start')}
        </Button>
        {error ? <p role="alert">{error}</p> : null}
      </div>
    )

  return (
    <form className="totp-enrollment" onSubmit={(event) => void submit(event)}>
      <ol>
        <li>{t('stepScan')}</li>
        <li>{t('stepCode')}</li>
      </ol>
      {/* biome-ignore lint/performance/noImgElement: a generated data URL; there is nothing to optimize. */}
      <img alt={t('qrAlt')} className="totp-qr" height={200} src={started.qr} width={200} />
      <p className="muted">
        {t('secretLabel')} <code>{groupedSecret(started.secret)}</code>
      </p>
      <TextField
        autoComplete="one-time-code"
        inputMode="numeric"
        label={t('code')}
        name="code"
        required
      />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button disabled={busy} type="submit" variant="primary">
        {t('confirm')}
      </Button>
    </form>
  )
}

/** Shown once, right after the first factor: ten codes, each good for one sign-in. */
export function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const t = useTranslations('security.recovery')
  return (
    <section className="panel recovery-codes" aria-labelledby="recovery-title">
      <h2 id="recovery-title">{t('title')}</h2>
      <p>{t('copy')}</p>
      <ul className="recovery-list">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <Button
          onClick={() =>
            void navigator.clipboard?.writeText(codes.join('\n')).catch(() => undefined)
          }
          type="button"
          variant="secondary"
        >
          {t('copyAll')}
        </Button>
        <Button onClick={onClose} type="button" variant="primary">
          {t('saved')}
        </Button>
      </div>
    </section>
  )
}
