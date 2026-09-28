'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Plus, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { ExportButton } from '@/components/ui/export-button'
import { Resource } from '@/components/ui/resource'
import { SelectField } from '@/components/ui/select-field'
import { Empty } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { PartyRegistrationForm } from '@/features/parties/party-registration-form'
import { SavedViewsMenu } from '@/features/views/saved-views-menu'
import { filtersOf, queryOf } from '@/lib/saved-views'
import { useUrlParam } from '@/lib/url-param'
import { useLoader } from '@/lib/use-loader'
import { AccountDialog } from './account-dialog'
import { type CrmAbilities, type CrmDirectory, loadDirectory, useCrmAbilities } from './crm-data'
import { accountName, personLabel } from './types'

export function AccountsPage() {
  const abilities = useCrmAbilities()
  const state = useLoader(loadDirectory)
  return (
    <Resource state={state}>
      {(data) => <AccountsView abilities={abilities} data={data} onChanged={state.reload} />}
    </Resource>
  )
}

const ROLE_FILTERS = ['all', 'prospect', 'customer', 'partner'] as const

/**
 * Every party the business is trying to win or keep (ADR 0057). A new prospect is
 * registered in Parties and appears here once CRM has projected it.
 */
function AccountsView({
  data,
  abilities,
  onChanged,
}: {
  data: CrmDirectory
  abilities: CrmAbilities
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const roles = useTranslations('partyRoles')
  const [search, setSearch] = useState('')
  const [role, setRole] = useState<string>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const openParam = useUrlParam('open')
  useEffect(() => {
    if (openParam) setOpenId(openParam)
  }, [openParam])
  const needle = search.trim().toLowerCase()
  const rows = data.accounts.filter(
    (row) =>
      (role === 'all' || row.roles.includes(role)) &&
      (!needle || accountName(row, '').toLowerCase().includes(needle)),
  )
  return (
    <section>
      <header className="page-heading page-heading-with-actions">
        <div>
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{t('accounts.title')}</h1>
          <p className="catalog-page-copy">{t('accounts.copy')}</p>
        </div>
        <div className="page-actions">
          <ExportButton path="crm/accounts" query={role === 'all' ? '' : `role=${role}`} />
          {abilities.canManageParties ? <NewProspectDialog onChanged={onChanged} /> : null}
        </div>
      </header>
      <div className="crm-toolbar">
        <TextField
          label={t('accounts.search')}
          onChange={(event) => setSearch(event.target.value)}
          type="search"
          value={search}
        />
        <SelectField
          label={t('accounts.role')}
          name="role"
          onValueChange={(value) => setRole(value ?? 'all')}
          options={ROLE_FILTERS.map((value) => ({
            label: value === 'all' ? t('accounts.allRoles') : roles(value),
            value,
          }))}
          value={role}
        />
        <SavedViewsMenu
          columns={null}
          onApply={(saved) => {
            const filters = filtersOf(saved.query)
            setSearch(filters.search ?? '')
            setRole(
              filters.role && ROLE_FILTERS.includes(filters.role as never) ? filters.role : 'all',
            )
          }}
          query={queryOf({ search: search.trim() || null, role: role === 'all' ? null : role })}
          screen="crm.accounts"
        />
      </div>
      {rows.length === 0 ? (
        <Empty copy={t('accounts.empty')} />
      ) : (
        <div className="panel table-panel table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('accounts.name')}</th>
                <th>{t('accounts.roles')}</th>
                <th>{t('accounts.document')}</th>
                <th>{t('table.owner')}</th>
                <th>{t('accounts.segment')}</th>
                <th>{t('table.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button
                      aria-label={t('accounts.open', {
                        name: accountName(row, t('unknownAccount')),
                      })}
                      className="crm-link-button"
                      onClick={() => setOpenId(row.id)}
                      type="button"
                    >
                      {accountName(row, t('unknownAccount'))}
                    </button>
                  </td>
                  <td>{row.roles.map((value) => roles(value)).join(', ')}</td>
                  <td>
                    {row.documentType ? t(`documentType.${row.documentType}`) : '—'}
                    {row.documentCountry ? ` · ${row.documentCountry}` : ''}
                  </td>
                  <td>{personLabel(data.names, row.ownerId, t('noOwner'))}</td>
                  <td>{row.segment ?? '—'}</td>
                  <td>
                    <Badge label={t(`accountStatus.${row.status}`)} status={row.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId ? (
        <AccountDialog
          abilities={abilities}
          accountId={openId}
          directory={data}
          onChanged={onChanged}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </section>
  )
}

/** A prospect is a party with the `prospect` role; CRM picks it up from the registry's event. */
function NewProspectDialog({ onChanged }: { onChanged: () => Promise<void> }) {
  const t = useTranslations('crm')
  const common = useTranslations('common')
  const setNotice = useNotice()
  const [open, setOpen] = useState(false)
  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary">
        <Plus aria-hidden="true" size={17} />
        {t('accounts.newProspect')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <div className="dialog-heading">
            <Dialog.Title>{t('accounts.newProspect')}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('accounts.newProspectDescription')}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <PartyRegistrationForm
            failedLabel={t('accounts.registerFailed')}
            key={String(open)}
            onRegistered={async () => {
              setOpen(false)
              setNotice(t('accounts.registered'))
              // CRM learns about the party from its event; give it a moment before reading.
              await new Promise((resolve) => setTimeout(resolve, 1_500))
              await onChanged()
            }}
            roles={['prospect']}
            showTradeName
            submitLabel={t('accounts.register')}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
