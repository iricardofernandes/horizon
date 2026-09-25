'use client'

import { useLocale, useTranslations } from 'next-intl'
import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PanelHeading } from '@/components/ui/headings'
import { TextField } from '@/components/ui/text-field'
import { apiError } from '@/lib/api'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'

type CertificateSummary = {
  establishment_id: string
  issuer_tax_id: string
  fingerprint: string
  valid_until: string
}

function base64(file: File, readFailed: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(readFailed))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}

export function FiscalCertificatePanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations('fiscalCertificate')
  const locale = useLocale()
  const [certificates, setCertificates] = useState<CertificateSummary[]>([])
  const [loading, setLoading] = useState(canManage)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!canManage) return
    let live = true
    void tracedFetch('fiscal.credentials.list', '/api/horizon/fiscal/establishment-credentials')
      .then(async (response) => {
        if (!response.ok) throw new Error(await apiError(response, t('listFailed')))
        return response.json() as Promise<{ data: CertificateSummary[] }>
      })
      .then((result) => {
        if (live) setCertificates(result.data)
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : t('listFailed'))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [canManage, t])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    const form = event.currentTarget
    const data = new FormData(form)
    const file = data.get('certificate')
    if (!(file instanceof File) || !file.size || file.size > 512 * 1024) {
      setError(t('fileInvalid'))
      setBusy(false)
      return
    }
    try {
      const response = await tracedFetch(
        'fiscal.credentials.upload',
        '/api/horizon/fiscal/establishment-credentials',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            establishmentId: String(data.get('establishmentId') ?? ''),
            pfxBase64: await base64(file, t('readFailed')),
            password: String(data.get('password') ?? ''),
          }),
        },
      )
      if (!response.ok) throw new Error(await apiError(response, t('saveFailed')))
      const saved = (await response.json()) as {
        establishmentId: string
        issuerTaxId: string
        fingerprint: string
        validUntil: string
      }
      setCertificates((current) => [
        {
          establishment_id: saved.establishmentId,
          issuer_tax_id: saved.issuerTaxId,
          fingerprint: saved.fingerprint,
          valid_until: saved.validUntil,
        },
        ...current.filter((item) => item.establishment_id !== saved.establishmentId),
      ])
      form.reset()
      setNotice(t('saved'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel form-panel">
      <PanelHeading title={t('title')} copy={t('copy')} />
      {!canManage ? (
        <p>{t('readOnly')}</p>
      ) : (
        <>
          {loading ? (
            <p>{t('loading')}</p>
          ) : certificates.length === 0 ? (
            <p>{t('empty')}</p>
          ) : (
            <ul>
              {certificates.map((item) => (
                <li key={item.establishment_id}>
                  <strong>{t('establishment', { id: item.establishment_id })}</strong> ·{' '}
                  {t('taxId', { value: item.issuer_tax_id })} ·{' '}
                  {t('validUntil', { date: new Date(item.valid_until).toLocaleDateString(locale) })}{' '}
                  · SHA-256 {item.fingerprint.slice(0, 12)}…
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={submit}>
            <TextField label={t('establishmentId')} name="establishmentId" required type="text" />
            <label className="ui-field">
              <span className="ui-field-label">{t('file')}</span>
              <input
                accept=".pfx,.p12,application/x-pkcs12"
                className="ui-input"
                name="certificate"
                required
                type="file"
              />
            </label>
            <TextField
              autoComplete="off"
              label={t('password')}
              name="password"
              required
              type="password"
            />
            {error ? <p role="alert">{error}</p> : null}
            {notice ? <p role="status">{notice}</p> : null}
            <Button disabled={busy} type="submit" variant="primary">
              {busy ? t('saving') : t('save')}
            </Button>
          </form>
        </>
      )}
    </section>
  )
}
