'use client'

import { Checkbox } from '@base-ui/react/checkbox'
import { Dialog } from '@base-ui/react/dialog'
import { Buildings, Check, Plus, Tag, User, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { apiError } from '@/lib/api'
import { jsonHeaders } from '@/lib/http'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import { kindOfTaxId, maskedTaxId, PARTY_ROLES, type Party, type PartyRole } from './party'

type MutationProps = { onChanged: () => Promise<void>; setNotice: (value: string) => void }

/** The shared registry: one record per tax identifier, holding every role it plays (ADR 0040). */
export function PartiesView({
  parties,
  onChanged,
  setNotice,
}: { parties: Party[] } & MutationProps) {
  const t = useTranslations('parties')
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLocaleLowerCase()
  const filtered = parties.filter(
    (party) =>
      !normalized ||
      party.legalName.toLocaleLowerCase().includes(normalized) ||
      party.email.toLocaleLowerCase().includes(normalized),
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
          <RegisterPartyDialog onChanged={onChanged} setNotice={setNotice} />
        </div>
      </header>
      <div className="access-toolbar">
        <div />
        <input
          aria-label={t('search')}
          className="ui-input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('searchPlaceholder')}
          type="search"
          value={query}
        />
      </div>
      <div className="panel table-panel">
        <div className="table-scroll">
          <PartiesTable parties={filtered} onChanged={onChanged} setNotice={setNotice} />
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

function PartiesTable({ parties, onChanged, setNotice }: { parties: Party[] } & MutationProps) {
  const t = useTranslations('parties')
  const common = useTranslations('common')
  const kinds = useTranslations('partyKinds')
  const roleName = useTranslations('partyRoles')
  const statusLabel = useStatusLabel()
  return (
    <table>
      <thead>
        <tr>
          <th>{t('party')}</th>
          <th>{t('kind')}</th>
          <th>{t('taxId')}</th>
          <th>{t('roles')}</th>
          <th>{t('status')}</th>
          <th aria-label={common('actions')} />
        </tr>
      </thead>
      <tbody>
        {parties.map((party) => (
          <tr key={party.id}>
            <td>
              <div className="resource-name">
                <span className="resource-icon" aria-hidden="true">
                  {party.kind === 'organization' ? <Buildings size={17} /> : <User size={17} />}
                </span>
                <span>
                  <strong>{party.legalName}</strong>
                  <small>{party.email}</small>
                </span>
              </div>
            </td>
            <td>{kinds(party.kind)}</td>
            <td>{maskedTaxId(party)}</td>
            <td>
              <div className="role-list">
                {party.roles.length ? (
                  party.roles.map((role) => (
                    <span className="role-chip" key={role}>
                      {roleName(role)}
                    </span>
                  ))
                ) : (
                  <span className="role-chip">{t('noRoles')}</span>
                )}
              </div>
            </td>
            <td>
              <Badge status={party.status} label={statusLabel(party.status)} />
            </td>
            <td>
              {party.status !== 'erased' ? (
                <PartyRolesDialog party={party} onChanged={onChanged} setNotice={setNotice} />
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RoleCheckboxes({
  name,
  selected,
  onToggle,
}: {
  name: string
  selected: readonly PartyRole[]
  onToggle?: (role: PartyRole, checked: boolean) => void
}) {
  const roleName = useTranslations('partyRoles')
  return (
    <div className="scope-grid">
      {PARTY_ROLES.map((role) => (
        <label htmlFor={`${name}-${role}`} key={role}>
          <Checkbox.Root
            checked={selected.includes(role)}
            className="ui-checkbox"
            id={`${name}-${role}`}
            name={name}
            onCheckedChange={(checked) => onToggle?.(role, checked)}
            value={role}
          >
            <Checkbox.Indicator>
              <Check aria-hidden="true" size={13} weight="bold" />
            </Checkbox.Indicator>
          </Checkbox.Root>
          <span>{roleName(role)}</span>
        </label>
      ))}
    </div>
  )
}

function RegisterPartyDialog({ onChanged, setNotice }: MutationProps) {
  const t = useTranslations('parties')
  const customers = useTranslations('customers')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [roles, setRoles] = useState<PartyRole[]>(['customer'])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = event.currentTarget
    const data = new FormData(form)
    const taxId = String(data.get('taxId') ?? '').trim()
    const tradeName = String(data.get('tradeName') ?? '').trim()
    const response = await tracedFetch('parties.party.register', '/api/horizon/parties/parties', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        kind: kindOfTaxId(taxId),
        legalName: String(data.get('legalName') ?? '').trim(),
        ...(tradeName ? { tradeName } : {}),
        taxId,
        email: String(data.get('email') ?? '').trim(),
        phone: String(data.get('phone') ?? '').trim(),
        address: String(data.get('address') ?? '').trim(),
        roles,
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
        <Plus aria-hidden="true" size={17} weight="bold" />
        {t('create')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup customer-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{t('createTitle')}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('createDescription')}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} weight="bold" />
          </Dialog.Close>
          <form className="dialog-form" onSubmit={submit}>
            <div className="form-grid two-columns">
              <TextField
                label={customers('name')}
                maxLength={160}
                minLength={2}
                name="legalName"
                required
              />
              <TextField label={t('tradeName')} maxLength={160} name="tradeName" />
            </div>
            <div className="form-grid two-columns">
              <TextField
                description={customers('taxIdHelp')}
                label={t('taxId')}
                maxLength={18}
                minLength={11}
                name="taxId"
                required
              />
              <TextField
                label={customers('email')}
                maxLength={254}
                name="email"
                required
                type="email"
              />
            </div>
            <TextField
              description={customers('phoneHelp')}
              label={customers('phone')}
              maxLength={24}
              minLength={8}
              name="phone"
              required
              type="tel"
            />
            <TextField
              label={customers('address')}
              maxLength={500}
              minLength={5}
              name="address"
              placeholder={customers('addressPlaceholder')}
              required
            />
            <fieldset className="scope-fieldset">
              <legend>{t('roles')}</legend>
              <RoleCheckboxes
                name="roles"
                onToggle={(role, checked) =>
                  setRoles((current) =>
                    checked
                      ? [...new Set([...current, role])]
                      : current.filter((held) => held !== role),
                  )
                }
                selected={roles}
              />
              <p className="settings-card-caption">{t('rolesHelp')}</p>
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
                {busy ? customers('saving') : t('createSubmit')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function PartyRolesDialog({ party, onChanged, setNotice }: { party: Party } & MutationProps) {
  const t = useTranslations('parties')
  const common = useTranslations('common')
  const roleName = useTranslations('partyRoles')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function toggle(role: PartyRole, checked: boolean) {
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      'parties.party.role',
      `/api/horizon/parties/parties/${party.id}/roles/${role}`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ operation: checked ? 'grant' : 'revoke' }),
      },
    )
    if (!response.ok) {
      setError(await apiError(response, t('roleChangeFailed')))
      setBusy(false)
      return
    }
    setNotice(
      t(checked ? 'roleGranted' : 'roleRevoked', { name: party.legalName, role: roleName(role) }),
    )
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root>
      <Dialog.Trigger className="ui-button ui-button-ghost row-action-button">
        <Tag aria-hidden="true" size={16} />
        {t('roles')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <div className="dialog-heading">
            <Dialog.Title>{t('rolesTitle', { name: party.legalName })}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('rolesDescription')}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <fieldset className="scope-fieldset" disabled={busy}>
            <legend>{t('roles')}</legend>
            <RoleCheckboxes
              name={`roles-${party.id}`}
              onToggle={(role, checked) => void toggle(role, checked)}
              selected={party.roles}
            />
          </fieldset>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <Dialog.Close className="ui-button ui-button-secondary">{common('close')}</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
