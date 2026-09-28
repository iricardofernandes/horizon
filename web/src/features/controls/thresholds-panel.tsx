'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useCallback, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Button } from '@/components/ui/button'
import { PanelHeading } from '@/components/ui/headings'
import { Resource } from '@/components/ui/resource'
import { SelectField } from '@/components/ui/select-field'
import { Notice } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { apiError, readPage } from '@/lib/api'
import { type ApprovalPolicy, minorUnitsOf, type ThresholdModule } from '@/lib/controls'
import { idempotentJsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime, useMoney } from '@/lib/use-format'
import { useLoader } from '@/lib/use-loader'

type Thresholds = { module: ThresholdModule; policies: ApprovalPolicy[] | null }

/**
 * Above these amounts a manual entry (Ledger) or a transfer (Treasury) waits for a second
 * person (ADR 0062). Without a threshold for a currency, nothing waits.
 */
export function ThresholdsPanel({
  readable,
  settable,
}: {
  readable: readonly ThresholdModule[]
  settable: readonly ThresholdModule[]
}) {
  const t = useTranslations('controls')
  const modules = useTranslations('modules')
  const money = useMoney()
  const dateTime = useDateTime()
  const load = useCallback(
    async (): Promise<Thresholds[]> =>
      Promise.all(
        readable.map(async (module) => {
          try {
            const policies = await readPage<ApprovalPolicy>(
              `${module}.approvalPolicies`,
              `/api/horizon/${module}/approval-policies`,
            )
            return { module, policies }
          } catch {
            return { module, policies: null }
          }
        }),
      ),
    [readable],
  )
  const state = useLoader(load)

  return (
    <section className="panel table-panel">
      <PanelHeading copy={t('thresholdsCopy')} title={t('thresholdsTitle')} />
      {settable.length ? <ThresholdForm onDone={state.reload} settable={settable} /> : null}
      <Resource state={state}>
        {(answers) => (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('module')}</th>
                  <th>{t('currency')}</th>
                  <th className="numeric">{t('threshold')}</th>
                  <th>{t('updatedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {answers.flatMap((answer) =>
                  answer.policies === null
                    ? [
                        <tr key={answer.module}>
                          <td>{modules(answer.module)}</td>
                          <td colSpan={3}>
                            {t('moduleSilent', { module: modules(answer.module) })}
                          </td>
                        </tr>,
                      ]
                    : answer.policies.length
                      ? answer.policies.map((policy) => (
                          <tr key={`${answer.module}-${policy.currency}`}>
                            <td>{modules(answer.module)}</td>
                            <td>{policy.currency}</td>
                            <td className="numeric">{money(policy.threshold, policy.currency)}</td>
                            <td>{dateTime(policy.updatedAt)}</td>
                          </tr>
                        ))
                      : [
                          <tr key={answer.module}>
                            <td>{modules(answer.module)}</td>
                            <td colSpan={3}>{t('noThreshold')}</td>
                          </tr>,
                        ],
                )}
              </tbody>
            </table>
          </div>
        )}
      </Resource>
    </section>
  )
}

function ThresholdForm({
  settable,
  onDone,
}: {
  settable: readonly ThresholdModule[]
  onDone: () => Promise<void>
}) {
  const t = useTranslations('controls')
  const modules = useTranslations('modules')
  const setNotice = useNotice()
  const [module, setModule] = useState<ThresholdModule>(settable[0] ?? 'ledger')
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const threshold = minorUnitsOf(String(form.get('amount') ?? ''))
    const currency = String(form.get('currency') ?? '')
      .trim()
      .toUpperCase()
    if (!threshold || !/^[A-Z]{3}$/.test(currency)) {
      setError(t('thresholdInvalid'))
      return
    }
    setError('')
    const response = await tracedFetch(
      `${module}.approvalPolicy.define`,
      `/api/horizon/${module}/approval-policies`,
      {
        method: 'PUT',
        headers: idempotentJsonHeaders(),
        body: JSON.stringify({ currency, threshold }),
      },
    )
    if (!response.ok) {
      setError(await apiError(response, t('thresholdFailed')))
      return
    }
    setNotice(t('thresholdSaved'))
    await onDone()
  }

  return (
    <form onSubmit={submit}>
      {error ? <Notice copy={error} /> : null}
      <div className="form-grid four-columns">
        <SelectField
          label={t('module')}
          name="module"
          onValueChange={(value) => setModule((value ?? settable[0]) as ThresholdModule)}
          options={settable.map((value) => ({ label: modules(value), value }))}
          value={module}
        />
        <TextField
          defaultValue="BRL"
          label={t('currency')}
          maxLength={3}
          name="currency"
          required
        />
        <TextField
          description={t('amountHint')}
          inputMode="decimal"
          label={t('threshold')}
          name="amount"
          required
        />
      </div>
      <div className="dialog-actions">
        <Button type="submit" variant="primary">
          {t('saveThreshold')}
        </Button>
      </div>
    </form>
  )
}
