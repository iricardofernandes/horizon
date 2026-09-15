'use client'

import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Checkbox } from '@base-ui/react/checkbox'
import { Dialog } from '@base-ui/react/dialog'
import { ArrowClockwise, Check, Copy, Key, Plus, Trash, X } from '@phosphor-icons/react'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { tracedFetch } from '@/lib/telemetry'

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

type SessionUser = { id: string; name: string; email: string }
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

export function SettingsView({
  user,
  workspaceName,
  apiKeys,
  onChanged,
  setNotice,
}: {
  user: SessionUser | null
  workspaceName: string
  apiKeys: ApiKeyRecord[]
} & MutationProps) {
  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">Workspace administration</p>
        <h1>Settings</h1>
        <p>Manage your current workspace context and machine credentials.</p>
      </header>

      <div className="settings-layout">
        <section className="panel workspace-settings-card">
          <header>
            <div className="brand-mark">{workspaceName.slice(0, 1).toUpperCase()}</div>
            <div>
              <h2>{workspaceName}</h2>
              <p className="settings-card-caption">Current workspace</p>
            </div>
          </header>
          <dl>
            <div>
              <dt>Signed in as</dt>
              <dd>{user?.name ?? '—'}</dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>{user?.email ?? '—'}</dd>
            </div>
          </dl>
          <a className="ui-button ui-button-secondary settings-link" href="/workspaces">
            Switch workspace
          </a>
        </section>

        <section className="panel api-key-panel">
          <header className="settings-section-heading">
            <div>
              <h2>API keys</h2>
              <p className="settings-card-caption">
                Machine credentials inherit only the scopes you explicitly grant.
              </p>
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
                  <StatusBadge status={apiKey.status} />
                  <small>
                    {apiKey.lastUsedAt
                      ? `Used ${new Date(apiKey.lastUsedAt).toLocaleDateString()}`
                      : 'Never used'}
                  </small>
                </div>
                {apiKey.status === 'active' ? (
                  <div className="row-actions">
                    <RotateApiKeyDialog apiKey={apiKey} onChanged={onChanged} />
                    <RevokeApiKeyDialog
                      apiKey={apiKey}
                      onChanged={onChanged}
                      setNotice={setNotice}
                    />
                  </div>
                ) : null}
              </article>
            ))}
            {!apiKeys.length ? (
              <div className="catalog-empty">
                <strong>No API keys</strong>
                <p>Create a scoped credential for an integration.</p>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </section>
  )
}

function CreateApiKeyDialog({ onChanged }: Pick<MutationProps, 'onChanged'>) {
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
      setError('Select at least one scope.')
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
      setError(await apiError(response, 'The API key could not be created.'))
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
        New API key
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup api-key-dialog">
          <div className="dialog-heading">
            <Dialog.Title>Create API key</Dialog.Title>
            <Dialog.Description className="dialog-description">
              The complete token is shown once and cannot be recovered.
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {token ? (
            <OneTimeToken token={token} />
          ) : (
            <form className="dialog-form" onSubmit={submit}>
              <TextField
                label="Key name"
                maxLength={200}
                name="name"
                placeholder="Store integration"
                required
              />
              <TextField
                description="Optional. The key remains active until revoked when left blank."
                label="Expires at"
                name="expiresAt"
                type="datetime-local"
              />
              <fieldset className="scope-fieldset">
                <legend>Scopes</legend>
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
                <Dialog.Close className="ui-button ui-button-secondary">Cancel</Dialog.Close>
                <Button disabled={busy} type="submit" variant="primary">
                  {busy ? 'Creating…' : 'Create API key'}
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
      setError(await apiError(response, 'The API key could not be rotated.'))
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
        Rotate
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <div className="dialog-heading">
            <Dialog.Title>Rotate {apiKey.name}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              Create a replacement token and keep the previous one valid for a short overlap.
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {token ? (
            <OneTimeToken token={token} />
          ) : (
            <form className="dialog-form" onSubmit={submit}>
              <TextField
                defaultValue="300"
                description="Between 0 and 604800 seconds."
                label="Overlap seconds"
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
                <Dialog.Close className="ui-button ui-button-secondary">Cancel</Dialog.Close>
                <Button disabled={busy} type="submit" variant="primary">
                  {busy ? 'Rotating…' : 'Rotate key'}
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
  const [busy, setBusy] = useState(false)
  async function revoke() {
    setBusy(true)
    const response = await tracedFetch(
      'identity.api-key.revoke',
      `/api/horizon/identity/api-keys/${apiKey.id}`,
      { method: 'DELETE' },
    )
    setNotice(response.ok ? `${apiKey.name} was revoked.` : 'The API key could not be revoked.')
    if (response.ok) await onChanged()
    setBusy(false)
  }
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        aria-label={`Revoke ${apiKey.name}`}
        className="ui-button ui-button-ghost icon-action danger-action"
      >
        <Trash aria-hidden="true" size={15} />
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-dialog-backdrop" />
        <AlertDialog.Popup className="ui-dialog-popup ui-alert-popup">
          <div className="dialog-heading">
            <AlertDialog.Title>Revoke {apiKey.name}?</AlertDialog.Title>
            <AlertDialog.Description className="dialog-description">
              Requests using this credential will stop working immediately.
            </AlertDialog.Description>
          </div>
          <div className="dialog-actions">
            <AlertDialog.Close className="ui-button ui-button-secondary">Cancel</AlertDialog.Close>
            <AlertDialog.Close
              className="ui-button ui-button-danger"
              disabled={busy}
              onClick={revoke}
            >
              {busy ? 'Revoking…' : 'Revoke key'}
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

function OneTimeToken({ token }: { token: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(token)
    setCopied(true)
  }
  return (
    <div className="one-time-token">
      <strong>Copy this token now</strong>
      <p className="one-time-token-caption">It will not be shown again after this dialog closes.</p>
      <code>{token}</code>
      <Button onClick={copy} type="button" variant="secondary">
        <Copy aria-hidden="true" size={16} />
        {copied ? 'Copied' : 'Copy token'}
      </Button>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>
}
function jsonHeaders() {
  return { 'content-type': 'application/json' }
}
async function apiError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { detail?: unknown; message?: unknown }
    const value = body.detail ?? body.message
    if (typeof value === 'string') return value
  } catch {}
  return fallback
}
