'use client'

import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Checkbox } from '@base-ui/react/checkbox'
import { Dialog } from '@base-ui/react/dialog'
import { ArrowClockwise, Check, Copy, Key, Plus, Trash, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading } from '@/components/ui/headings'
import { TextField } from '@/components/ui/text-field'
import { apiError } from '@/lib/api'
import { jsonHeaders } from '@/lib/http'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import { useDate } from '@/lib/use-format'

export type ApiKeyRecord = {
  id: string
  name: string
  prefix: string
  scopes: string[]
  status: 'active' | 'rotating' | 'revoked' | 'expired'
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

type MutationProps = { onChanged: () => Promise<void>; setNotice: (value: string) => void }

const scopeOptions = [
  'identity:read',
  'catalog:read',
  'catalog:write',
  'inventory:read',
  'inventory:write',
  'sales:read',
  'sales:write',
  'webhooks:read',
  'webhooks:write',
]

export function ApiKeysView({
  apiKeys,
  onChanged,
  setNotice,
}: { apiKeys: ApiKeyRecord[] } & MutationProps) {
  const t = useTranslations('apiKeys')
  const statusLabel = useStatusLabel()
  const date = useDate()
  return (
    <section>
      <PageHeading eyebrow={t('eyebrow')} title={t('title')} copy={t('copy')} />
      <section className="panel api-key-panel">
        <header className="settings-section-heading">
          <div>
            <h2>{t('keys')}</h2>
            <p className="settings-card-caption">{t('keysCopy')}</p>
          </div>
          <CreateApiKeyDialog onChanged={onChanged} />
        </header>
        <div className="api-key-list">
          {apiKeys.map((apiKey) => (
            <article key={apiKey.id}>
              <span className="resource-icon">
                <Key aria-hidden="true" size={17} />
              </span>
              <div className="api-key-copy">
                <strong>{apiKey.name}</strong>
                <code>{apiKey.prefix}••••••••</code>
                <small>{apiKey.scopes.join(', ')}</small>
              </div>
              <div className="api-key-meta">
                <Badge status={apiKey.status} label={statusLabel(apiKey.status)} />
                <small>
                  {apiKey.lastUsedAt
                    ? t('usedOn', { date: date(apiKey.lastUsedAt) })
                    : t('neverUsed')}
                </small>
              </div>
              {apiKey.status === 'active' ? (
                <div className="row-actions">
                  <RotateApiKeyDialog apiKey={apiKey} onChanged={onChanged} />
                  <RevokeApiKeyDialog apiKey={apiKey} onChanged={onChanged} setNotice={setNotice} />
                </div>
              ) : null}
            </article>
          ))}
          {!apiKeys.length ? (
            <div className="catalog-empty">
              <strong>{t('emptyTitle')}</strong>
              <p>{t('emptyCopy')}</p>
            </div>
          ) : null}
        </div>
      </section>
    </section>
  )
}

function CreateApiKeyDialog({ onChanged }: Pick<MutationProps, 'onChanged'>) {
  const t = useTranslations('apiKeys')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [token, setToken] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const data = new FormData(event.currentTarget)
    const scopes = data.getAll('scopes')
    if (!scopes.length) {
      setError(t('selectScope'))
      setBusy(false)
      return
    }
    const expiresAtValue = String(data.get('expiresAt') ?? '')
    const response = await tracedFetch(
      'identity.api-key.create',
      '/api/horizon/identity/api-keys',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          name: String(data.get('name') ?? '').trim(),
          scopes,
          ...(expiresAtValue ? { expiresAt: new Date(expiresAtValue).toISOString() } : {}),
        }),
      },
    )
    if (!response.ok) {
      setError(await apiError(response, t('createFailed')))
      setBusy(false)
      return
    }
    const created = (await response.json()) as { token: string }
    setToken(created.token)
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) setToken('')
      }}
      open={open}
    >
      <Dialog.Trigger className="ui-button ui-button-primary">
        <Plus aria-hidden="true" size={16} />
        {t('create')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup api-key-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{t('createTitle')}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('createDescription')}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {token ? (
            <OneTimeToken token={token} />
          ) : (
            <form className="dialog-form" onSubmit={submit}>
              <TextField
                label={t('name')}
                maxLength={200}
                name="name"
                placeholder={t('namePlaceholder')}
                required
              />
              <TextField
                description={t('expiresAtHelp')}
                label={t('expiresAt')}
                name="expiresAt"
                type="datetime-local"
              />
              <fieldset className="scope-fieldset">
                <legend>{t('scopes')}</legend>
                <div className="scope-grid">
                  {scopeOptions.map((scope) => (
                    <label htmlFor={`scope-${scope}`} key={scope}>
                      <Checkbox.Root
                        className="ui-checkbox"
                        id={`scope-${scope}`}
                        name="scopes"
                        value={scope}
                      >
                        <Checkbox.Indicator>
                          <Check aria-hidden="true" size={13} weight="bold" />
                        </Checkbox.Indicator>
                      </Checkbox.Root>
                      <span>{scope}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="dialog-actions">
                <Dialog.Close className="ui-button ui-button-secondary">
                  {common('cancel')}
                </Dialog.Close>
                <Button disabled={busy} type="submit" variant="primary">
                  {busy ? t('creating') : t('createSubmit')}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function RotateApiKeyDialog({
  apiKey,
  onChanged,
}: { apiKey: ApiKeyRecord } & Pick<MutationProps, 'onChanged'>) {
  const t = useTranslations('apiKeys')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [token, setToken] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const data = new FormData(event.currentTarget)
    const response = await tracedFetch(
      'identity.api-key.rotate',
      `/api/horizon/identity/api-keys/${apiKey.id}/rotate`,
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ overlapSeconds: Number(data.get('overlapSeconds')) }),
      },
    )
    if (!response.ok) {
      setError(await apiError(response, t('rotateFailed')))
      setBusy(false)
      return
    }
    const rotated = (await response.json()) as { token: string }
    setToken(rotated.token)
    await onChanged()
    setBusy(false)
  }
  return (
    <Dialog.Root
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) setToken('')
      }}
      open={open}
    >
      <Dialog.Trigger className="ui-button ui-button-ghost row-action-button">
        <ArrowClockwise aria-hidden="true" size={15} />
        {t('rotate')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <div className="dialog-heading">
            <Dialog.Title>{t('rotateTitle', { name: apiKey.name })}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('rotateDescription')}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {token ? (
            <OneTimeToken token={token} />
          ) : (
            <form className="dialog-form" onSubmit={submit}>
              <TextField
                defaultValue="300"
                description={t('overlapHelp')}
                label={t('overlapSeconds')}
                max="604800"
                min="0"
                name="overlapSeconds"
                required
                type="number"
              />
              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="dialog-actions">
                <Dialog.Close className="ui-button ui-button-secondary">
                  {common('cancel')}
                </Dialog.Close>
                <Button disabled={busy} type="submit" variant="primary">
                  {busy ? t('rotating') : t('rotateSubmit')}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function RevokeApiKeyDialog({
  apiKey,
  onChanged,
  setNotice,
}: { apiKey: ApiKeyRecord } & MutationProps) {
  const t = useTranslations('apiKeys')
  const common = useTranslations('common')
  const [busy, setBusy] = useState(false)
  async function revoke() {
    setBusy(true)
    const response = await tracedFetch(
      'identity.api-key.revoke',
      `/api/horizon/identity/api-keys/${apiKey.id}`,
      { method: 'DELETE' },
    )
    setNotice(response.ok ? t('revoked', { name: apiKey.name }) : t('revokeFailed'))
    if (response.ok) await onChanged()
    setBusy(false)
  }
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        aria-label={t('revokeLabel', { name: apiKey.name })}
        className="ui-button ui-button-ghost icon-action danger-action"
      >
        <Trash aria-hidden="true" size={15} />
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-dialog-backdrop" />
        <AlertDialog.Popup className="ui-dialog-popup ui-alert-popup">
          <div className="dialog-heading">
            <AlertDialog.Title>{t('revokeTitle', { name: apiKey.name })}</AlertDialog.Title>
            <AlertDialog.Description className="dialog-description">
              {t('revokeDescription')}
            </AlertDialog.Description>
          </div>
          <div className="dialog-actions">
            <AlertDialog.Close className="ui-button ui-button-secondary">
              {common('cancel')}
            </AlertDialog.Close>
            <AlertDialog.Close
              className="ui-button ui-button-danger"
              disabled={busy}
              onClick={revoke}
            >
              {busy ? t('revoking') : t('revokeSubmit')}
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

function OneTimeToken({ token }: { token: string }) {
  const t = useTranslations('apiKeys')
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(token)
    setCopied(true)
  }
  return (
    <div className="one-time-token">
      <strong>{t('oneTimeTitle')}</strong>
      <p className="one-time-token-caption">{t('oneTimeCopy')}</p>
      <code>{token}</code>
      <Button onClick={copy} type="button" variant="secondary">
        <Copy aria-hidden="true" size={16} />
        {copied ? t('copied') : t('copyToken')}
      </Button>
    </div>
  )
}
