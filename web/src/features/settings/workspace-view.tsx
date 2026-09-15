'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { apiError } from '@/lib/api'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'

type SessionUser = { id: string; name: string; email: string }

export type CompanyProfile = {
  legalName: string
  tradeName: string | null
  taxId: string | null
  stateRegistration: string | null
  municipalRegistration: string | null
  address: {
    line: string | null
    city: string | null
    state: string | null
    postalCode: string | null
    country: string
  }
  baseCurrency: string
  fiscalRegime: string
}

export type Workspace = {
  id: string
  name: string
  slug: string
  timezone: string
  status: string
  baseCurrency: string
  company: CompanyProfile | null
}

export function WorkspaceView({
  user,
  workspace,
  canManage,
  onChanged,
  setNotice,
}: {
  user: SessionUser | null
  workspace: Workspace
  canManage: boolean
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const t = useTranslations('workspaceSettings')
  return (
    <section>
      <PageHeading eyebrow={t('eyebrow')} title={t('title')} copy={t('copy')} />
      <div className="settings-layout">
        <section className="panel workspace-settings-card">
          <header>
            <div className="brand-mark">{workspace.name.slice(0, 1).toUpperCase()}</div>
            <div>
              <h2>{workspace.name}</h2>
              <p className="settings-card-caption">{t('currentWorkspace')}</p>
            </div>
          </header>
          <dl>
            <div>
              <dt>{t('signedInAs')}</dt>
              <dd>{user?.name ?? t('none')}</dd>
            </div>
            <div>
              <dt>{t('account')}</dt>
              <dd>{user?.email ?? t('none')}</dd>
            </div>
            <div>
              <dt>{t('baseCurrency')}</dt>
              <dd>{workspace.baseCurrency}</dd>
            </div>
            <div>
              <dt>{t('timezone')}</dt>
              <dd>{workspace.timezone}</dd>
            </div>
          </dl>
          <a className="ui-button ui-button-secondary settings-link" href="/workspaces">
            {t('switchWorkspace')}
          </a>
        </section>

        <CompanyPanel
          canManage={canManage}
          onChanged={onChanged}
          setNotice={setNotice}
          workspace={workspace}
        />
      </div>
    </section>
  )
}

function CompanyPanel({
  workspace,
  canManage,
  onChanged,
  setNotice,
}: {
  workspace: Workspace
  canManage: boolean
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const t = useTranslations('workspaceSettings')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const company = workspace.company

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const data = new FormData(event.currentTarget)
    const response = await tracedFetch(
      'identity.workspace.company',
      '/api/horizon/identity/workspace/company',
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({
          legalName: text(data, 'legalName'),
          tradeName: text(data, 'tradeName'),
          taxId: text(data, 'taxId'),
          stateRegistration: text(data, 'stateRegistration'),
          municipalRegistration: text(data, 'municipalRegistration'),
          addressLine: text(data, 'addressLine'),
          addressCity: text(data, 'addressCity'),
          addressState: text(data, 'addressState'),
          addressPostalCode: text(data, 'addressPostalCode'),
          addressCountry: text(data, 'addressCountry') ?? 'BR',
          baseCurrency: text(data, 'baseCurrency') ?? 'BRL',
          fiscalRegime: data.get('fiscalRegime'),
          timezone: text(data, 'timezone') ?? workspace.timezone,
        }),
      },
    )
    if (!response.ok) {
      setError(await apiError(response, t('saveFailed')))
      setBusy(false)
      return
    }
    setNotice(t('saved'))
    await onChanged()
    setBusy(false)
  }

  const regimes = [
    { label: t('regimeSimplesNacional'), value: 'simples-nacional' },
    { label: t('regimeLucroPresumido'), value: 'lucro-presumido' },
    { label: t('regimeLucroReal'), value: 'lucro-real' },
    { label: t('regimeMei'), value: 'mei' },
    { label: t('regimeNotDeclared'), value: 'not-declared' },
  ]

  if (!canManage) return <CompanyReadout company={company} regimes={regimes} />

  return (
    <form className="panel form-panel" onSubmit={submit}>
      <PanelHeading title={t('company')} copy={t('companyCopy')} />
      <TextField
        defaultValue={company?.legalName ?? ''}
        label={t('legalName')}
        maxLength={200}
        name="legalName"
        required
      />
      <div className="form-grid two-columns">
        <TextField
          defaultValue={company?.tradeName ?? ''}
          label={t('tradeName')}
          maxLength={200}
          name="tradeName"
        />
        <TextField
          defaultValue={company?.taxId ?? ''}
          label={t('taxId')}
          maxLength={20}
          name="taxId"
        />
      </div>
      <div className="form-grid two-columns">
        <TextField
          defaultValue={company?.stateRegistration ?? ''}
          label={t('stateRegistration')}
          maxLength={40}
          name="stateRegistration"
        />
        <TextField
          defaultValue={company?.municipalRegistration ?? ''}
          label={t('municipalRegistration')}
          maxLength={40}
          name="municipalRegistration"
        />
      </div>
      <TextField
        defaultValue={company?.address.line ?? ''}
        label={t('addressLine')}
        maxLength={500}
        name="addressLine"
      />
      <div className="form-grid two-columns">
        <TextField
          defaultValue={company?.address.city ?? ''}
          label={t('addressCity')}
          maxLength={120}
          name="addressCity"
        />
        <TextField
          defaultValue={company?.address.state ?? ''}
          label={t('addressState')}
          maxLength={120}
          name="addressState"
        />
      </div>
      <div className="form-grid two-columns">
        <TextField
          defaultValue={company?.address.postalCode ?? ''}
          label={t('addressPostalCode')}
          maxLength={20}
          name="addressPostalCode"
        />
        <TextField
          defaultValue={company?.address.country ?? 'BR'}
          label={t('addressCountry')}
          maxLength={2}
          minLength={2}
          name="addressCountry"
          pattern="[A-Za-z]{2}"
        />
      </div>
      <div className="form-grid two-columns">
        <TextField
          defaultValue={workspace.baseCurrency}
          description={t('baseCurrencyHelp')}
          label={t('baseCurrency')}
          maxLength={3}
          minLength={3}
          name="baseCurrency"
          pattern="[A-Za-z]{3}"
          required
        />
        <SelectField
          defaultValue={company?.fiscalRegime ?? 'not-declared'}
          label={t('fiscalRegime')}
          name="fiscalRegime"
          options={regimes}
          required
        />
      </div>
      <TextField
        defaultValue={workspace.timezone}
        description={t('timezoneHelp')}
        label={t('timezone')}
        maxLength={64}
        name="timezone"
        required
      />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button disabled={busy} type="submit" variant="primary">
        {busy ? t('saving') : t('save')}
      </Button>
    </form>
  )
}

function CompanyReadout({
  company,
  regimes,
}: {
  company: CompanyProfile | null
  regimes: readonly { label: string; value: string }[]
}) {
  const t = useTranslations('workspaceSettings')
  return (
    <section className="panel">
      <PanelHeading title={t('company')} copy={t('companyCopy')} />
      <dl className="company-readout">
        <div>
          <dt>{t('legalName')}</dt>
          <dd>{company?.legalName ?? t('notDescribed')}</dd>
        </div>
        <div>
          <dt>{t('taxId')}</dt>
          <dd>{company?.taxId ?? t('none')}</dd>
        </div>
        <div>
          <dt>{t('fiscalRegime')}</dt>
          <dd>
            {regimes.find((regime) => regime.value === company?.fiscalRegime)?.label ??
              t('regimeNotDeclared')}
          </dd>
        </div>
      </dl>
      <p className="settings-card-caption">{t('readOnly')}</p>
    </section>
  )
}

function text(data: FormData, field: string): string | null {
  const value = String(data.get(field) ?? '').trim()
  return value.length === 0 ? null : value
}
