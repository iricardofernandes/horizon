'use client'

import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog } from '@base-ui/react/dialog'
import { Key, Plus, ShieldCheck, UserMinus, UserPlus, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { jsonHeaders } from '@/lib/http'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime } from '@/lib/use-format'

type ModuleName = 'identity' | 'catalog' | 'inventory' | 'sales' | 'webhooks'
type RoleAssignment = { module: ModuleName; role: string }

export type WorkspaceUser = {
  id: string
  name: string
  email: string
  roles: RoleAssignment[]
  status: 'active' | 'disabled' | 'erased'
  lastLoginAt: string | null
  createdAt: string
}

const roleOptions: Record<ModuleName, string[]> = {
  identity: ['owner', 'admin', 'member'],
  catalog: ['admin', 'editor', 'viewer'],
  inventory: ['admin', 'operator', 'viewer'],
  sales: ['admin', 'representative', 'viewer'],
  webhooks: ['admin', 'viewer'],
}

const modules = Object.keys(roleOptions) as ModuleName[]

const profiles: Record<'admin' | 'operator' | 'viewer', RoleAssignment[]> = {
  admin: modules.map((module) => ({ module, role: 'admin' })),
  operator: [
    { module: 'identity', role: 'member' },
    { module: 'catalog', role: 'editor' },
    { module: 'inventory', role: 'operator' },
    { module: 'sales', role: 'representative' },
    { module: 'webhooks', role: 'viewer' },
  ],
  viewer: [
    { module: 'identity', role: 'member' },
    { module: 'catalog', role: 'viewer' },
    { module: 'inventory', role: 'viewer' },
    { module: 'sales', role: 'viewer' },
    { module: 'webhooks', role: 'viewer' },
  ],
}

export function AccessView({
  users,
  currentUserId,
  onChanged,
  setNotice,
}: {
  users: WorkspaceUser[]
  currentUserId: string | undefined
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const t = useTranslations('access')
  const common = useTranslations('common')
  const moduleName = useTranslations('modules')
  const roleName = useTranslations('roles')
  const statusLabel = useStatusLabel()
  const dateTime = useDateTime()
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLocaleLowerCase()
  const filtered = users.filter(
    (user) =>
      !normalized ||
      user.name.toLocaleLowerCase().includes(normalized) ||
      user.email.toLocaleLowerCase().includes(normalized),
  )

  return (
    <section>
      <header className="page-heading page-heading-with-actions">
        <div>
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{t('title')}</h1>
          <p className="catalog-page-copy">{t('copy')}</p>
        </div>
        <div className="page-actions">
          <CreateUserDialog onChanged={onChanged} setNotice={setNotice} />
        </div>
      </header>

      <div className="access-toolbar">
        <div>
          <strong>{users.filter((user) => user.status === 'active').length}</strong>
          <span className="access-count-label">{t('activeMembers')}</span>
        </div>
        <input
          aria-label={t('search')}
          className="ui-input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('searchPlaceholder')}
          type="search"
          value={query}
        />
      </div>

      <div className="panel table-panel access-table-panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('member')}</th>
                <th>{t('roles')}</th>
                <th>{t('lastLogin')}</th>
                <th>{t('status')}</th>
                <th aria-label={common('actions')} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((user) => (
                <tr key={user.id}>
                  <td>
                    <div className="resource-name">
                      <span className="access-avatar">{user.name.slice(0, 1).toUpperCase()}</span>
                      <span>
                        <strong>{user.name}</strong>
                        <small>
                          {user.email}
                          {user.id === currentUserId ? t('you') : ''}
                        </small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="role-list">
                      {user.roles.map((role) => (
                        <span className="role-chip" key={`${role.module}:${role.role}`}>
                          {moduleName(role.module)}: {roleName(role.role)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>{user.lastLoginAt ? dateTime(user.lastLoginAt) : t('never')}</td>
                  <td>
                    <Badge status={user.status} label={statusLabel(user.status)} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <ManageRolesDialog user={user} onChanged={onChanged} setNotice={setNotice} />
                      {user.status === 'active' && user.id !== currentUserId ? (
                        <DisableUserDialog
                          user={user}
                          onChanged={onChanged}
                          setNotice={setNotice}
                        />
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length ? (
          <div className="catalog-empty">
            <strong>{t('emptyTitle')}</strong>
            <p>{t('emptyCopy')}</p>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function CreateUserDialog({ onChanged, setNotice }: MutationProps) {
  const t = useTranslations('access')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = event.currentTarget
    const data = new FormData(form)
    const profile = String(data.get('profile') ?? 'viewer') as keyof typeof profiles
    const response = await tracedFetch('identity.user.create', '/api/horizon/identity/users', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: String(data.get('name') ?? '').trim(),
        email: String(data.get('email') ?? '').trim(),
        password: data.get('password'),
        roles: profiles[profile],
      }),
    })
    if (!response.ok) {
      setError(await apiError(response, t('createFailed')))
      setBusy(false)
      return
    }
    form.reset()
    setOpen(false)
    setNotice(t('created'))
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary">
        <UserPlus aria-hidden="true" size={17} />
        {t('create')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <DialogHeading title={t('createTitle')} description={t('createDescription')} />
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <form className="dialog-form" onSubmit={submit}>
            <TextField label={t('name')} name="name" maxLength={200} required />
            <TextField label={t('email')} name="email" maxLength={254} required type="email" />
            <TextField
              description={t('passwordHelp')}
              label={t('password')}
              name="password"
              minLength={12}
              required
              type="password"
            />
            <SelectField
              label={t('profile')}
              name="profile"
              options={[
                { label: t('profileOperator'), value: 'operator' },
                { label: t('profileViewer'), value: 'viewer' },
                { label: t('profileAdmin'), value: 'admin' },
              ]}
              required
            />
            <FormActions busy={busy} error={error} label={t('create')} />
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ManageRolesDialog({
  user,
  onChanged,
  setNotice,
}: MutationProps & { user: WorkspaceUser }) {
  const t = useTranslations('access')
  const common = useTranslations('common')
  const moduleName = useTranslations('modules')
  const roleName = useTranslations('roles')
  const [open, setOpen] = useState(false)
  const [module, setModule] = useState<ModuleName>('catalog')
  const [role, setRole] = useState(roleOptions.catalog[0] ?? 'admin')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function change(assignment: RoleAssignment, operation: 'grant' | 'revoke') {
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      'identity.user.role',
      `/api/horizon/identity/users/${user.id}/roles`,
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ assignment, operation }) },
    )
    if (!response.ok) {
      setError(await apiError(response, t('roleChangeFailed')))
      setBusy(false)
      return
    }
    setNotice(
      operation === 'grant'
        ? t('roleGranted', { module: assignment.module, role: assignment.role })
        : t('roleRevoked', { module: assignment.module, role: assignment.role }),
    )
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-ghost row-action-button">
        <ShieldCheck aria-hidden="true" size={16} />
        {t('roles')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <DialogHeading
            title={t('rolesTitle', { name: user.name })}
            description={t('rolesDescription')}
          />
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <div className="assigned-role-list">
            {user.roles.map((assignment) => (
              <div key={`${assignment.module}:${assignment.role}`}>
                <span>
                  <Key aria-hidden="true" size={15} />
                  <strong>{moduleName(assignment.module)}</strong>
                  <small>{roleName(assignment.role)}</small>
                </span>
                <Button disabled={busy} onClick={() => change(assignment, 'revoke')} type="button">
                  {t('revoke')}
                </Button>
              </div>
            ))}
          </div>
          <div className="role-grant-form">
            <SelectField
              label={t('module')}
              name="module"
              onValueChange={(value) => {
                const next = (value ?? 'catalog') as ModuleName
                setModule(next)
                setRole(roleOptions[next][0] ?? 'admin')
              }}
              options={modules.map((value) => ({ label: moduleName(value), value }))}
              value={module}
            />
            <SelectField
              label={t('role')}
              name="role"
              onValueChange={(value) => setRole(value ?? roleOptions[module][0] ?? 'admin')}
              options={roleOptions[module].map((value) => ({ label: roleName(value), value }))}
              value={role}
            />
            <Button
              disabled={busy}
              onClick={() => change({ module, role }, 'grant')}
              type="button"
              variant="secondary"
            >
              <Plus aria-hidden="true" size={16} />
              {t('grantRole')}
            </Button>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function DisableUserDialog({
  user,
  onChanged,
  setNotice,
}: MutationProps & { user: WorkspaceUser }) {
  const t = useTranslations('access')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function disable() {
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      'identity.user.disable',
      `/api/horizon/identity/users/${user.id}/disable`,
      { method: 'PATCH' },
    )
    if (!response.ok) {
      setError(await apiError(response, t('disableFailed')))
      setBusy(false)
      return
    }
    setNotice(t('disabled', { name: user.name }))
    await onChanged()
    setOpen(false)
    setBusy(false)
  }

  return (
    <AlertDialog.Root onOpenChange={setOpen} open={open}>
      <AlertDialog.Trigger className="ui-button ui-button-ghost row-action-button danger-action">
        <UserMinus aria-hidden="true" size={16} />
        {t('disable')}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-dialog-backdrop" />
        <AlertDialog.Popup className="ui-dialog-popup ui-alert-popup">
          <div className="dialog-heading">
            <AlertDialog.Title>{t('disableTitle', { name: user.name })}</AlertDialog.Title>
            <AlertDialog.Description className="dialog-description">
              {t('disableDescription')}
            </AlertDialog.Description>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <AlertDialog.Close className="ui-button ui-button-secondary">
              {common('cancel')}
            </AlertDialog.Close>
            <Button disabled={busy} onClick={disable} type="button" variant="danger">
              {busy ? t('disabling') : t('disableSubmit')}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

type MutationProps = { onChanged: () => Promise<void>; setNotice: (value: string) => void }

function DialogHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="dialog-heading">
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description className="dialog-description">{description}</Dialog.Description>
    </div>
  )
}

function FormActions({ busy, error, label }: { busy: boolean; error: string; label: string }) {
  const t = useTranslations('access')
  const common = useTranslations('common')
  return (
    <>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <Dialog.Close className="ui-button ui-button-secondary">{common('cancel')}</Dialog.Close>
        <Button disabled={busy} type="submit" variant="primary">
          {busy ? t('saving') : label}
        </Button>
      </div>
    </>
  )
}

async function apiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown; message?: unknown; title?: unknown }
    const message = body.detail ?? body.message ?? body.title
    if (Array.isArray(message)) return message.join(' ')
    if (typeof message === 'string' && message.trim()) return message
  } catch {}
  return fallback
}
