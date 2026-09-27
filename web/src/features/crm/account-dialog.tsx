'use client'

import { Dialog } from '@base-ui/react/dialog'
import { X } from '@phosphor-icons/react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { Empty, LoadingState, Notice } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { useMoney } from '@/lib/use-format'
import { type CrmAbilities, type CrmDirectory, newKey, readCrm, send } from './crm-data'
import { RecordForms } from './record-forms'
import { Timeline } from './timeline'
import {
  type Account,
  accountName,
  type Contact,
  type Opportunity,
  personLabel,
  type TimelineEntry,
} from './types'

type Loaded = {
  account: Account & { contacts: Contact[] }
  opportunities: Opportunity[]
  timeline: TimelineEntry[]
}

const LAWFUL_BASES = ['contract', 'legitimate-interest', 'consent'] as const
const NONE = 'none'

async function loadAccount(id: string): Promise<Loaded> {
  const [account, opportunities, timeline] = await Promise.all([
    readCrm<Account & { contacts: Contact[] }>('crm.account', `/accounts/${id}`),
    readCrm<{ data: Opportunity[] }>(
      'crm.account.opportunities',
      `/opportunities?accountId=${id}&limit=100`,
    ),
    readCrm<{ data: TimelineEntry[] }>(
      'crm.account.timeline',
      `/accounts/${id}/timeline?limit=100`,
    ),
  ])
  return { account, opportunities: opportunities.data, timeline: timeline.data }
}

/** One account: its profile, the people there, its opportunities and its history (Phases 55–57). */
export function AccountDialog({
  accountId,
  directory,
  abilities,
  onClose,
  onChanged,
}: {
  accountId: string
  directory: CrmDirectory
  abilities: CrmAbilities
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const common = useTranslations('common')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      setLoaded(await loadAccount(accountId))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [accountId])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = async () => {
    await Promise.all([load(), onChanged()])
  }

  return (
    <Dialog.Root onOpenChange={(open) => (open ? undefined : onClose())} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup document-dialog crm-dialog">
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {failed ? <Notice copy={t('accounts.unavailable')} /> : null}
          {!failed && !loaded ? <LoadingState /> : null}
          {loaded ? (
            <>
              <div className="dialog-heading">
                <Dialog.Title>{accountName(loaded.account, t('unknownAccount'))}</Dialog.Title>
                <Badge
                  label={t(`accountStatus.${loaded.account.status}`)}
                  status={loaded.account.status}
                />
              </div>
              <Profile
                abilities={abilities}
                account={loaded.account}
                directory={directory}
                refresh={refresh}
              />
              <Contacts abilities={abilities} account={loaded.account} refresh={refresh} />
              <Opportunities directory={directory} rows={loaded.opportunities} />
              {abilities.canWrite && loaded.account.status === 'active' ? (
                <section className="crm-section">
                  <h3>{t('records.heading')}</h3>
                  <RecordForms
                    canAssign={abilities.canAssign}
                    contacts={loaded.account.contacts}
                    directory={directory}
                    onRecorded={refresh}
                    subject={{ type: 'account', id: loaded.account.id }}
                    userId={abilities.userId}
                  />
                </section>
              ) : null}
              <section className="crm-section">
                <h3>{t('timeline.title')}</h3>
                <Timeline directory={directory} entries={loaded.timeline} />
              </section>
            </>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Profile({
  account,
  directory,
  abilities,
  refresh,
}: {
  account: Account
  directory: CrmDirectory
  abilities: CrmAbilities
  refresh: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const setNotice = useNotice()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const editable = abilities.canWrite && account.status !== 'erased'
  const sources = directory.sources.filter((row) => !row.archived || row.id === account.sourceId)
  const owners = directory.owners.filter((row) => row.active || row.userId === account.ownerId)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const sourceId = String(form.get('sourceId') ?? NONE)
    const ownerId = String(form.get('ownerId') ?? NONE)
    const body: Record<string, unknown> = {
      segment: String(form.get('segment') ?? '') || null,
      tags: String(form.get('tags') ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      sourceId: sourceId === NONE ? null : sourceId,
    }
    if (abilities.canAssign) body.ownerId = ownerId === NONE ? null : ownerId
    setBusy(true)
    setError('')
    const result = await send('crm.account.profile', 'PATCH', `/accounts/${account.id}`, {
      body,
      fallback: t('accounts.profileFailed'),
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setNotice(t('accounts.profileSaved'))
    await refresh()
  }

  return (
    <section className="crm-section">
      <h3>{t('accounts.profile')}</h3>
      {/* Remounted when the saved profile changes, so every field starts from it. */}
      <form
        className="dialog-form"
        key={[account.ownerId, account.sourceId, account.segment, ...account.tags].join('|')}
        onSubmit={submit}
      >
        <div className="crm-form-row">
          <SelectField
            defaultValue={account.ownerId ?? NONE}
            disabled={!editable || !abilities.canAssign}
            label={t('table.owner')}
            name="ownerId"
            options={[
              { label: t('noOwner'), value: NONE },
              ...owners.map((row) => ({
                label: personLabel(directory.names, row.userId, t('noOwner')),
                value: row.userId,
              })),
            ]}
          />
          <SelectField
            defaultValue={account.sourceId ?? NONE}
            disabled={!editable}
            label={t('opportunity.source')}
            name="sourceId"
            options={[
              { label: t('opportunity.noSource'), value: NONE },
              ...sources.map((row) => ({ label: row.name, value: row.id })),
            ]}
          />
        </div>
        <div className="crm-form-row">
          <TextField
            defaultValue={account.segment ?? ''}
            disabled={!editable}
            label={t('accounts.segment')}
            maxLength={80}
            name="segment"
          />
          <TextField
            defaultValue={account.tags.join(', ')}
            disabled={!editable}
            label={t('accounts.tags')}
            name="tags"
          />
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {editable ? (
          <div className="dialog-actions">
            <Button disabled={busy} type="submit" variant="secondary">
              {t('accounts.saveProfile')}
            </Button>
          </div>
        ) : null}
      </form>
    </section>
  )
}

function Contacts({
  account,
  abilities,
  refresh,
}: {
  account: Account & { contacts: Contact[] }
  abilities: CrmAbilities
  refresh: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const setNotice = useNotice()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [round, setRound] = useState(0)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const optional = (name: string) => String(form.get(name) ?? '').trim() || null
    setBusy(true)
    setError('')
    const result = await send('crm.contact.create', 'POST', `/accounts/${account.id}/contacts`, {
      key: newKey(),
      fallback: t('contacts.failed'),
      body: {
        name: form.get('name'),
        jobTitle: optional('jobTitle'),
        email: optional('email'),
        phone: optional('phone'),
        lawfulBasis: form.get('lawfulBasis'),
      },
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setNotice(t('contacts.created'))
    setRound((value) => value + 1)
    await refresh()
  }

  return (
    <section className="crm-section">
      <h3>{t('contacts.title')}</h3>
      {account.contacts.length === 0 ? (
        <Empty copy={t('contacts.empty')} />
      ) : (
        <ul className="crm-contact-list">
          {account.contacts.map((contact) => (
            <li key={contact.id}>
              <strong>{contact.name ?? t('contacts.erased')}</strong>
              {contact.jobTitle ? ` · ${contact.jobTitle}` : ''}
              {contact.email ? ` · ${contact.email}` : ''}
              {contact.phone ? ` · ${contact.phone}` : ''}
              {contact.status !== 'active' ? ` · ${t(`contactStatus.${contact.status}`)}` : ''}
            </li>
          ))}
        </ul>
      )}
      {abilities.canWrite && account.status === 'active' ? (
        <form className="dialog-form" key={round} onSubmit={submit}>
          <div className="crm-form-row">
            <TextField
              label={t('contacts.name')}
              maxLength={160}
              minLength={2}
              name="name"
              required
            />
            <TextField label={t('contacts.jobTitle')} maxLength={120} name="jobTitle" />
          </div>
          <div className="crm-form-row">
            <TextField label={t('contacts.email')} name="email" type="email" />
            <TextField label={t('contacts.phone')} name="phone" type="tel" />
            <SelectField
              label={t('contacts.lawfulBasis')}
              name="lawfulBasis"
              options={LAWFUL_BASES.map((value) => ({ label: t(`lawfulBasis.${value}`), value }))}
            />
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <Button disabled={busy} type="submit" variant="secondary">
              {t('contacts.add')}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  )
}

function Opportunities({
  rows,
  directory,
}: {
  rows: readonly Opportunity[]
  directory: CrmDirectory
}) {
  const t = useTranslations('crm')
  const money = useMoney()
  return (
    <section className="crm-section">
      <h3>{t('accounts.opportunities')}</h3>
      {rows.length === 0 ? (
        <Empty copy={t('accounts.noOpportunities')} />
      ) : (
        <ul className="crm-quote-list">
          {rows.map((row) => {
            const pipeline = directory.pipelines.find(
              (candidate) => candidate.id === row.pipelineId,
            )
            const stage = pipeline?.stages.find((candidate) => candidate.id === row.stageId)
            return (
              <li key={row.id}>
                <Link href={`/app/crm/pipeline?open=${row.id}`}>{row.title}</Link> · {stage?.name} ·{' '}
                {money(row.expectedValue.amount, row.expectedValue.currency)} ·{' '}
                {t(`opportunityStatus.${row.status}`)}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
