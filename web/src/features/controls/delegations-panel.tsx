'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useCallback, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PanelHeading } from '@/components/ui/headings'
import { Resource } from '@/components/ui/resource'
import { SelectField } from '@/components/ui/select-field'
import { Notice } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { apiError, readPage } from '@/lib/api'
import {
  DELEGABLE,
  type DelegatingModule,
  type Delegation,
  periodOf,
  revocable,
  sortDelegations,
} from '@/lib/controls'
import { idempotentJsonHeaders } from '@/lib/http'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import { useDate } from '@/lib/use-format'
import { useLoader } from '@/lib/use-loader'

type ModuleDelegations = { module: DelegatingModule; delegations: Delegation[] | null }

/**
 * Approvals lent for a period (ADR 0062). Each module keeps its own; one that does not answer
 * is named instead of hidden. The module refuses a loan of an approval the person lacks.
 */
export function DelegationsPanel({
  readable,
  lending,
}: {
  readable: readonly DelegatingModule[]
  lending: readonly DelegatingModule[]
}) {
  const t = useTranslations('controls')
  const modules = useTranslations('modules')
  const load = useCallback(
    async (): Promise<ModuleDelegations[]> =>
      Promise.all(
        readable.map(async (module) => {
          try {
            const delegations = await readPage<Delegation>(
              `${module}.delegations`,
              `/api/horizon/${module}/delegations`,
            )
            return { module, delegations: sortDelegations(delegations) }
          } catch {
            return { module, delegations: null }
          }
        }),
      ),
    [readable],
  )
  const state = useLoader(load)

  return (
    <section className="panel table-panel">
      <PanelHeading copy={t('delegationsCopy')} title={t('delegationsTitle')} />
      {lending.length ? <GrantForm lending={lending} onDone={state.reload} /> : null}
      <Resource state={state}>
        {(answers) => (
          <>
            {answers
              .filter((answer) => answer.delegations === null)
              .map((answer) => (
                <Notice
                  copy={t('moduleSilent', { module: modules(answer.module) })}
                  key={answer.module}
                />
              ))}
            <DelegationTable
              onDone={state.reload}
              rows={answers.flatMap((answer) =>
                (answer.delegations ?? []).map((delegation) => ({
                  module: answer.module,
                  delegation,
                })),
              )}
            />
          </>
        )}
      </Resource>
    </section>
  )
}

function GrantForm({
  lending,
  onDone,
}: {
  lending: readonly DelegatingModule[]
  onDone: () => Promise<void>
}) {
  const t = useTranslations('controls')
  const modules = useTranslations('modules')
  const setNotice = useNotice()
  const [module, setModule] = useState<DelegatingModule>(lending[0] ?? 'ledger')
  const [permission, setPermission] = useState(DELEGABLE[module][0] ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const period = periodOf(String(form.get('from') ?? ''), String(form.get('to') ?? ''))
    if (!period) {
      setError(t('periodInvalid'))
      return
    }
    const reason = String(form.get('reason') ?? '').trim()
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      `${module}.delegation.grant`,
      `/api/horizon/${module}/delegations`,
      {
        method: 'POST',
        headers: idempotentJsonHeaders(),
        body: JSON.stringify({
          permission,
          delegateId: String(form.get('delegateId') ?? '').trim(),
          ...period,
          ...(reason ? { reason } : {}),
        }),
      },
    )
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('grantFailed')))
      return
    }
    setNotice(t('granted'))
    await onDone()
  }

  return (
    <form className="delegation-form" onSubmit={submit}>
      {error ? <Notice copy={error} /> : null}
      <div className="form-grid four-columns">
        <SelectField
          label={t('module')}
          name="module"
          onValueChange={(value) => {
            const chosen = (value ?? lending[0]) as DelegatingModule
            setModule(chosen)
            setPermission(DELEGABLE[chosen][0] ?? '')
          }}
          options={lending.map((value) => ({ label: modules(value), value }))}
          value={module}
        />
        <SelectField
          label={t('permission')}
          name="permission"
          onValueChange={(value) => setPermission(value ?? '')}
          options={DELEGABLE[module].map((value) => ({
            label: t(`permissions.${value.replaceAll(':', '_')}`),
            value,
          }))}
          value={permission}
        />
        <TextField
          description={t('delegateHint')}
          label={t('delegate')}
          maxLength={200}
          name="delegateId"
          required
        />
        <TextField label={t('from')} name="from" required type="date" />
        <TextField label={t('to')} name="to" required type="date" />
        <TextField label={t('reason')} maxLength={500} name="reason" />
      </div>
      <div className="dialog-actions">
        <Button disabled={busy} type="submit" variant="primary">
          {t('grant')}
        </Button>
      </div>
    </form>
  )
}

function DelegationTable({
  rows,
  onDone,
}: {
  rows: { module: DelegatingModule; delegation: Delegation }[]
  onDone: () => Promise<void>
}) {
  const t = useTranslations('controls')
  const modules = useTranslations('modules')
  const statusLabel = useStatusLabel()
  const date = useDate()
  const setNotice = useNotice()
  const [error, setError] = useState('')

  async function revoke(module: DelegatingModule, id: string) {
    setError('')
    const response = await tracedFetch(
      `${module}.delegation.revoke`,
      `/api/horizon/${module}/delegations/${id}/revoke`,
      { method: 'POST', headers: idempotentJsonHeaders() },
    )
    if (!response.ok) {
      setError(await apiError(response, t('revokeFailed')))
      return
    }
    setNotice(t('revoked'))
    await onDone()
  }

  if (!rows.length) return <p className="catalog-page-copy">{t('noDelegations')}</p>
  return (
    <>
      {error ? <Notice copy={error} /> : null}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('module')}</th>
              <th>{t('permission')}</th>
              <th>{t('delegator')}</th>
              <th>{t('delegate')}</th>
              <th>{t('period')}</th>
              <th>{t('status')}</th>
              <th aria-label={t('revoke')} />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ module, delegation }) => (
              <tr key={delegation.id}>
                <td>{modules(module)}</td>
                <td>{t(`permissions.${delegation.permission.replaceAll(':', '_')}`)}</td>
                <td>{delegation.delegatorId}</td>
                <td>{delegation.delegateId}</td>
                <td>
                  {date(delegation.startsAt)} – {date(delegation.endsAt)}
                </td>
                <td>
                  <Badge label={statusLabel(delegation.status)} status={delegation.status} />
                </td>
                <td>
                  {revocable(delegation) ? (
                    <Button
                      onClick={() => void revoke(module, delegation.id)}
                      type="button"
                      variant="ghost"
                    >
                      {t('revoke')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
