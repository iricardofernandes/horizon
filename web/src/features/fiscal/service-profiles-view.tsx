'use client'

import { Dialog } from '@base-ui/react/dialog'
import { X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { Empty } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { useDate } from '@/lib/use-format'
import { fiscalCommand, useFiscalRole } from './client'
import { localToday, profileOn, profileRequest, type ServiceProfile } from './service-profiles'

export type ServiceItemProfiles = {
  itemId: string
  name: string
  sku: string
  active: boolean
  revisions: ServiceProfile[]
}

/**
 * What each Catalog service is for tax: the national code and NBS its NFS-e carries. A
 * revision takes effect on a date and never rewrites a document already issued.
 */
export function ServiceProfilesView({
  items,
  onChanged,
}: {
  items: ServiceItemProfiles[]
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('fiscal')
  const date = useDate()
  const role = useFiscalRole()
  const [open, setOpen] = useState<ServiceItemProfiles | null>(null)
  const today = localToday()
  return (
    <section className="fiscal-page">
      <PageHeading
        eyebrow={t('eyebrow')}
        title={t('serviceProfiles.title')}
        copy={t('serviceProfiles.copy')}
      />
      <section className="panel">
        <PanelHeading
          title={t('serviceProfiles.panelTitle')}
          copy={t('serviceProfiles.panelCopy')}
        />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('serviceProfiles.service')}</th>
                <th>{t('serviceProfiles.nationalTaxCode')}</th>
                <th>{t('serviceProfiles.nbsCode')}</th>
                <th>{t('serviceProfiles.effectiveFrom')}</th>
                <th>{t('serviceProfiles.state')}</th>
                <th aria-label={t('documents.open')} />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const { current, upcoming } = profileOn(item.revisions, today)
                return (
                  <tr key={item.itemId}>
                    <td>
                      <strong>{item.name}</strong> · {item.sku}
                    </td>
                    <td>
                      {current ? (
                        <code className="table-code">{current.nationalTaxCode}</code>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{current ? <code className="table-code">{current.nbsCode}</code> : '—'}</td>
                    <td>{current ? date(current.effectiveFrom) : '—'}</td>
                    <td>
                      {current ? (
                        <Badge
                          label={t('serviceProfiles.revision', { revision: current.revision })}
                          status="approved"
                        />
                      ) : (
                        <Badge label={t('serviceProfiles.missing')} status="pending" />
                      )}
                      {upcoming ? (
                        <small className="fiscal-upcoming">
                          {t('serviceProfiles.upcoming', { date: date(upcoming.effectiveFrom) })}
                        </small>
                      ) : null}
                    </td>
                    <td>
                      <Button
                        aria-label={t('serviceProfiles.openItem', { name: item.name })}
                        onClick={() => setOpen(item)}
                        type="button"
                      >
                        {t('serviceProfiles.open')}
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!items.length ? <Empty copy={t('serviceProfiles.empty')} /> : null}
        </div>
      </section>
      {open ? (
        <ProfileDialog
          canManage={role === 'admin'}
          item={open}
          onChanged={onChanged}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </section>
  )
}

function ProfileDialog({
  item,
  canManage,
  onClose,
  onChanged,
}: {
  item: ServiceItemProfiles
  canManage: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('fiscal')
  const common = useTranslations('common')
  const date = useDate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revisions, setRevisions] = useState(item.revisions)
  const latest = [...revisions].sort((left, right) => right.revision - left.revision)[0]

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const data = new FormData(event.currentTarget)
    const read = (name: string) => String(data.get(name) ?? '')
    const built = profileRequest({
      itemId: item.itemId,
      nationalTaxCode: read('nationalTaxCode'),
      nbsCode: read('nbsCode'),
      municipalTaxCode: read('municipalTaxCode'),
      description: read('description'),
      effectiveFrom: read('effectiveFrom'),
      reason: read('reason'),
    })
    if (!built.ok) {
      setError(t(`serviceProfiles.${built.problem}`))
      return
    }
    setBusy(true)
    const outcome = await fiscalCommand(
      'fiscal.service-profile.create',
      '/service-profiles',
      built.body,
    )
    setBusy(false)
    if (!outcome.ok) {
      setError(
        t('actions.refused', {
          code: outcome.code ?? String(outcome.status),
          detail: outcome.detail ?? t('actions.noDetail'),
        }),
      )
      return
    }
    setRevisions((current) => [...current, outcome.body as ServiceProfile])
    await onChanged()
  }

  return (
    <Dialog.Root onOpenChange={(open) => !open && onClose()} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup order-detail-dialog fiscal-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{item.name}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('serviceProfiles.dialogDescription', { sku: item.sku })}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <h3>{t('serviceProfiles.history')}</h3>
          {revisions.length ? (
            <ul className="fiscal-list">
              {[...revisions]
                .sort((left, right) => right.revision - left.revision)
                .map((profile) => (
                  <li key={profile.revision}>
                    <span>
                      {t('serviceProfiles.historyLine', {
                        revision: profile.revision,
                        code: profile.nationalTaxCode,
                        nbs: profile.nbsCode,
                        date: date(profile.effectiveFrom),
                      })}
                    </span>
                    <small>{profile.createdBy}</small>
                  </li>
                ))}
            </ul>
          ) : (
            <Empty copy={t('serviceProfiles.noHistory')} />
          )}
          {canManage ? (
            <form className="dialog-form" onSubmit={submit}>
              <h3>{t('serviceProfiles.newRevision')}</h3>
              <div className="fiscal-form-row">
                <TextField
                  defaultValue={latest?.nationalTaxCode ?? ''}
                  description={t('serviceProfiles.nationalTaxCodeHint')}
                  label={t('serviceProfiles.nationalTaxCode')}
                  name="nationalTaxCode"
                  required
                />
                <TextField
                  defaultValue={latest?.nbsCode ?? ''}
                  description={t('serviceProfiles.nbsCodeHint')}
                  label={t('serviceProfiles.nbsCode')}
                  name="nbsCode"
                  required
                />
              </div>
              <TextField
                defaultValue={latest?.municipalTaxCode ?? ''}
                label={t('serviceProfiles.municipalTaxCode')}
                name="municipalTaxCode"
              />
              <TextField
                defaultValue={latest?.description ?? item.name}
                label={t('serviceProfiles.description')}
                maxLength={2000}
                name="description"
                required
              />
              <TextField
                defaultValue={localToday()}
                label={t('serviceProfiles.effectiveFrom')}
                name="effectiveFrom"
                required
                type="date"
              />
              <TextField
                label={t('serviceProfiles.reason')}
                maxLength={1000}
                minLength={10}
                name="reason"
                required
              />
              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
              <Button disabled={busy} type="submit" variant="primary">
                {busy ? t('actions.sending') : t('serviceProfiles.save')}
              </Button>
            </form>
          ) : (
            <p className="dialog-description">{t('serviceProfiles.readOnly')}</p>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
