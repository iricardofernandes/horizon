'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PanelHeading } from '@/components/ui/headings'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { apiError } from '@/lib/api'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime } from '@/lib/use-format'
import { useStepUp } from './step-up'

type Policy = { policy: 'off' | 'admins' | 'everyone'; graceDays: number; enrollBy: string | null }

const PATH = '/api/horizon/identity/workspace/mfa-policy'

/**
 * Who must have a second factor in this workspace (ADR 0061 §3): nobody, administrators or
 * everyone, with days of grace to enroll. Changing it asks for a step-up.
 */
export function MfaPolicyPanel({
  canManage,
  setNotice,
}: {
  canManage: boolean
  setNotice: (value: string) => void
}) {
  const t = useTranslations('workspaceSettings.mfa')
  const dateTime = useDateTime()
  const { run, dialog } = useStepUp()
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [choice, setChoice] = useState<Policy['policy']>('off')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const response = await tracedFetch('identity.mfa-policy', PATH)
    if (!response.ok) return
    const current = (await response.json()) as Policy
    setPolicy(current)
    setChoice(current.policy)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const graceDays = Number(new FormData(event.currentTarget).get('graceDays') ?? 0)
    setBusy(true)
    const response = await run(() =>
      tracedFetch('identity.mfa-policy.change', PATH, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ policy: choice, graceDays }),
      }),
    )
    setBusy(false)
    setNotice(response.ok ? t('saved') : await apiError(response, t('failed')))
    await load()
  }

  return (
    <section className="panel">
      <PanelHeading copy={t('copy')} title={t('title')} />
      {policy?.enrollBy ? (
        <p className="muted">{t('enrollBy', { date: dateTime(policy.enrollBy) })}</p>
      ) : null}
      <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <SelectField
          disabled={!canManage}
          label={t('policy')}
          name="policy"
          onValueChange={(value) => setChoice((value as Policy['policy'] | null) ?? 'off')}
          options={(['off', 'admins', 'everyone'] as const).map((value) => ({
            label: t(`options.${value}`),
            value,
          }))}
          value={choice}
        />
        <TextField
          defaultValue={String(policy?.graceDays ?? 7)}
          disabled={!canManage}
          key={policy?.graceDays ?? 'grace'}
          label={t('graceDays')}
          max={30}
          min={0}
          name="graceDays"
          type="number"
        />
        {canManage ? (
          <Button disabled={busy} type="submit" variant="secondary">
            {t('save')}
          </Button>
        ) : null}
      </form>
      {dialog}
    </section>
  )
}
