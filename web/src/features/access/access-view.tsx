'use client'

import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog } from '@base-ui/react/dialog'
import { Key, Plus, ShieldCheck, UserMinus, UserPlus, X } from '@phosphor-icons/react'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { tracedFetch } from '@/lib/telemetry'

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
          <p className="eyebrow">Workspace administration</p>
          <h1>People & access</h1>
          <p className="catalog-page-copy">
            Invite operators and control their permissions independently in each module.
          </p>
        </div>
        <div className="page-actions">
          <CreateUserDialog onChanged={onChanged} setNotice={setNotice} />
        </div>
      </header>

      <div className="access-toolbar">
        <div>
          <strong>{users.filter((user) => user.status === 'active').length}</strong>
          <span className="access-count-label">active members</span>
        </div>
        <input
          aria-label="Search workspace users"
          className="ui-input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name or email…"
          type="search"
          value={query}
        />
      </div>

      <div className="panel table-panel access-table-panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Roles</th>
                <th>Last login</th>
                <th>Status</th>
                <th aria-label="Actions" />
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
                          {user.id === currentUserId ? ' · You' : ''}
                        </small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="role-list">
                      {user.roles.map((role) => (
                        <span className="role-chip" key={`${role.module}:${role.role}`}>
                          {role.module}: {role.role}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}
                  </td>
                  <td>
                    <StatusBadge status={user.status} />
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
            <strong>No members found</strong>
            <p>Invite a member or adjust your search.</p>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function CreateUserDialog({ onChanged, setNotice }: MutationProps) {
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
      setError(await apiError(response, 'The user could not be created.'))
      setBusy(false)
      return
    }
    form.reset()
    setOpen(false)
    setNotice('Workspace member created successfully.')
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary">
        <UserPlus aria-hidden="true" size={17} />
        Add member
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <DialogHeading
            title="Add workspace member"
            description="Create credentials and an initial permission profile."
          />
          <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <form className="dialog-form" onSubmit={submit}>
            <TextField label="Name" name="name" maxLength={200} required />
            <TextField label="Email" name="email" maxLength={254} required type="email" />
            <TextField
              description="At least 12 characters."
              label="Temporary password"
              name="password"
              minLength={12}
              required
              type="password"
            />
            <SelectField
              label="Access profile"
              name="profile"
              options={[
                { label: 'Operator · manage daily operations', value: 'operator' },
                { label: 'Viewer · read-only access', value: 'viewer' },
                { label: 'Administrator · full module access', value: 'admin' },
              ]}
              required
            />
            <FormActions busy={busy} error={error} label="Add member" />
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
      setError(await apiError(response, 'The role could not be changed.'))
      setBusy(false)
      return
    }
    setNotice(
      `${assignment.module}:${assignment.role} ${operation === 'grant' ? 'granted' : 'revoked'}.`,
    )
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-ghost row-action-button">
        <ShieldCheck aria-hidden="true" size={16} />
        Roles
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <DialogHeading
            title={`Roles for ${user.name}`}
            description="Roles are independent per bounded context."
          />
          <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <div className="assigned-role-list">
            {user.roles.map((assignment) => (
              <div key={`${assignment.module}:${assignment.role}`}>
                <span>
                  <Key aria-hidden="true" size={15} />
                  <strong>{assignment.module}</strong>
                  <small>{assignment.role}</small>
                </span>
                <Button disabled={busy} onClick={() => change(assignment, 'revoke')} type="button">
                  Revoke
                </Button>
              </div>
            ))}
          </div>
          <div className="role-grant-form">
            <SelectField
              label="Module"
              name="module"
              onValueChange={(value) => {
                const next = (value ?? 'catalog') as ModuleName
                setModule(next)
                setRole(roleOptions[next][0] ?? 'admin')
              }}
              options={modules.map((value) => ({ label: capitalize(value), value }))}
              value={module}
            />
            <SelectField
              label="Role"
              name="role"
              onValueChange={(value) => setRole(value ?? roleOptions[module][0] ?? 'admin')}
              options={roleOptions[module].map((value) => ({ label: capitalize(value), value }))}
              value={role}
            />
            <Button
              disabled={busy}
              onClick={() => change({ module, role }, 'grant')}
              type="button"
              variant="secondary"
            >
              <Plus aria-hidden="true" size={16} />
              Grant role
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
      setError(await apiError(response, 'The member could not be disabled.'))
      setBusy(false)
      return
    }
    setNotice(`${user.name} was disabled.`)
    await onChanged()
    setOpen(false)
    setBusy(false)
  }

  return (
    <AlertDialog.Root onOpenChange={setOpen} open={open}>
      <AlertDialog.Trigger className="ui-button ui-button-ghost row-action-button danger-action">
        <UserMinus aria-hidden="true" size={16} />
        Disable
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-dialog-backdrop" />
        <AlertDialog.Popup className="ui-dialog-popup ui-alert-popup">
          <div className="dialog-heading">
            <AlertDialog.Title>Disable {user.name}?</AlertDialog.Title>
            <AlertDialog.Description className="dialog-description">
              Their active sessions will be revoked and they will no longer be able to sign in.
            </AlertDialog.Description>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <AlertDialog.Close className="ui-button ui-button-secondary">Cancel</AlertDialog.Close>
            <Button disabled={busy} onClick={disable} type="button" variant="danger">
              {busy ? 'Disabling…' : 'Disable member'}
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
  return (
    <>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <Dialog.Close className="ui-button ui-button-secondary">Cancel</Dialog.Close>
        <Button disabled={busy} type="submit" variant="primary">
          {busy ? 'Saving…' : label}
        </Button>
      </div>
    </>
  )
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>
}

function jsonHeaders() {
  return { 'content-type': 'application/json' }
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

function capitalize(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}
