'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Warning } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { apiError } from '@/lib/api'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import {
  type DocumentChoice,
  documentOf,
  kindOfTaxId,
  type PartyDocumentInput,
  type PartyKind,
  type PartyRole,
  requiresContact,
} from './party'

type Lookalike = {
  partyId: string
  legalName: string
  roles: PartyRole[]
  matchedOn: ('document' | 'name' | 'email' | 'phone')[]
}

type RegistrationFormProps = {
  roles: readonly PartyRole[]
  /** Extra fields between the contact block and the actions, such as the role choice. */
  children?: ReactNode
  showTradeName?: boolean
  submitLabel: string
  failedLabel: string
  onRegistered: () => Promise<void>
}

function text(data: FormData, name: string): string {
  return String(data.get(name) ?? '').trim()
}

/**
 * One registration form for every screen that creates a party (ADR 0057).
 *
 * The document may be Brazilian, foreign or absent; contacts are required only for the
 * roles whose documents need them. Before creating, the registry is asked whether this
 * looks like someone it already holds, and a lookalike must be confirmed, not ignored.
 */
export function PartyRegistrationForm({
  roles,
  children,
  showTradeName = false,
  submitLabel,
  failedLabel,
  onRegistered,
}: RegistrationFormProps) {
  const t = useTranslations('parties')
  const customers = useTranslations('customers')
  const kinds = useTranslations('partyKinds')
  const common = useTranslations('common')
  const [choice, setChoice] = useState<DocumentChoice>('brazilian')
  const [kind, setKind] = useState<PartyKind>('organization')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [lookalikes, setLookalikes] = useState<Lookalike[]>([])
  const [confirmedProbe, setConfirmedProbe] = useState('')
  const contactRequired = requiresContact(roles)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = event.currentTarget
    const registration = registrationOf(new FormData(form), choice, kind, roles)
    const probe = JSON.stringify(registration.probe)
    if (probe !== confirmedProbe) {
      const found = await findLookalikes(registration.probe)
      if (found.length) {
        setLookalikes(found)
        setConfirmedProbe(probe)
        setBusy(false)
        return
      }
    }
    const response = await tracedFetch('parties.party.register', '/api/horizon/parties/parties', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(registration.body),
    })
    if (!response.ok) {
      setError(await apiError(response, failedLabel))
      setBusy(false)
      return
    }
    form.reset()
    setLookalikes([])
    setConfirmedProbe('')
    await onRegistered()
    setBusy(false)
  }

  return (
    <form className="dialog-form" onSubmit={submit}>
      <div className={showTradeName ? 'form-grid two-columns' : undefined}>
        <TextField
          label={customers('name')}
          maxLength={160}
          minLength={2}
          name="legalName"
          required
        />
        {showTradeName ? (
          <TextField label={t('tradeName')} maxLength={160} name="tradeName" />
        ) : null}
      </div>
      <div className="form-grid two-columns">
        <SelectField
          label={t('documentType')}
          name="documentChoice"
          onValueChange={(value) => setChoice((value as DocumentChoice | null) ?? 'brazilian')}
          options={[
            { value: 'brazilian', label: t('documentChoices.brazilian') },
            { value: 'foreign', label: t('documentChoices.foreign') },
            { value: 'none', label: t('documentChoices.none') },
          ]}
          value={choice}
        />
        {choice === 'brazilian' ? (
          <TextField
            description={customers('taxIdHelp')}
            label={t('taxId')}
            maxLength={18}
            minLength={11}
            name="documentNumber"
            required
          />
        ) : (
          <SelectField
            label={t('kind')}
            name="kind"
            onValueChange={(value) => setKind((value as PartyKind | null) ?? 'organization')}
            options={[
              { value: 'organization', label: kinds('organization') },
              { value: 'person', label: kinds('person') },
            ]}
            value={kind}
          />
        )}
      </div>
      {choice === 'foreign' ? (
        <div className="form-grid two-columns">
          <TextField
            description={t('countryHelp')}
            label={t('documentCountry')}
            maxLength={2}
            minLength={2}
            name="documentCountry"
            pattern="[A-Za-z]{2}"
            required
          />
          <TextField
            label={t('documentNumber')}
            maxLength={40}
            minLength={1}
            name="documentNumber"
            required
          />
        </div>
      ) : null}
      <div className="form-grid two-columns">
        <TextField
          label={customers('email')}
          maxLength={254}
          name="email"
          required={contactRequired}
          type="email"
        />
        <TextField
          description={customers('phoneHelp')}
          label={customers('phone')}
          maxLength={24}
          minLength={8}
          name="phone"
          required={contactRequired}
          type="tel"
        />
      </div>
      <TextField
        description={contactRequired ? undefined : t('contactOptional')}
        label={customers('address')}
        maxLength={500}
        minLength={5}
        name="address"
        placeholder={customers('addressPlaceholder')}
        required={contactRequired}
      />
      {children}
      {lookalikes.length ? <LookalikeWarning lookalikes={lookalikes} /> : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <Dialog.Close className="ui-button ui-button-secondary">{common('cancel')}</Dialog.Close>
        <Button disabled={busy} type="submit" variant="primary">
          {busy ? customers('saving') : lookalikes.length ? t('registerAnyway') : submitLabel}
        </Button>
      </div>
    </form>
  )
}

type Probe = {
  legalName: string
  document: PartyDocumentInput
  email: string
  phone: string
}

/**
 * Blank optional fields are left out, so the registry reads them as absent, not invalid. A
 * Brazilian number goes as the `taxId` shorthand: the registry decides CPF or CNPJ and
 * explains a malformed one in the terms people know.
 */
function registrationOf(
  data: FormData,
  choice: DocumentChoice,
  kind: PartyKind,
  roles: readonly PartyRole[],
): { probe: Probe; body: Record<string, unknown> } {
  const number = text(data, 'documentNumber')
  const document = documentOf(choice, { number, country: text(data, 'documentCountry') })
  const digits = number.replace(/[.\-/\s]/g, '').length
  const probe: Probe = {
    legalName: text(data, 'legalName'),
    document:
      choice === 'brazilian' && digits !== 11 && digits !== 14 ? { type: 'none' } : document,
    email: text(data, 'email'),
    phone: text(data, 'phone'),
  }
  const present = (entries: Record<string, string>) =>
    Object.fromEntries(Object.entries(entries).filter(([, value]) => value))
  return {
    probe,
    body: {
      kind: choice === 'brazilian' ? kindOfTaxId(number) : kind,
      legalName: probe.legalName,
      ...(choice === 'brazilian' ? { taxId: number } : { document }),
      ...present({
        tradeName: text(data, 'tradeName'),
        email: probe.email,
        phone: probe.phone,
        address: text(data, 'address'),
      }),
      roles,
    },
  }
}

async function findLookalikes(probe: Probe): Promise<Lookalike[]> {
  const response = await tracedFetch(
    'parties.party.duplicate-check',
    '/api/horizon/parties/parties/duplicate-check',
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        legalName: probe.legalName,
        ...(probe.email ? { email: probe.email } : {}),
        ...(probe.phone ? { phone: probe.phone } : {}),
        ...(probe.document.type === 'none' ? {} : { document: probe.document }),
      }),
    },
  )
  // The check is advice: when it cannot answer, registration goes on and the registry still
  // refuses a repeated document.
  if (!response.ok) return []
  return ((await response.json()) as { data: Lookalike[] }).data
}

function LookalikeWarning({ lookalikes }: { lookalikes: Lookalike[] }) {
  const t = useTranslations('parties')
  return (
    <div className="form-warning" role="status">
      <strong>
        <Warning aria-hidden="true" size={16} weight="bold" /> {t('duplicateTitle')}
      </strong>
      <p>{t('duplicateCopy')}</p>
      <ul>
        {lookalikes.map((match) => (
          <li key={match.partyId}>
            {match.legalName} · {match.matchedOn.map((field) => t(`matchedOn.${field}`)).join(', ')}
          </li>
        ))}
      </ul>
    </div>
  )
}
