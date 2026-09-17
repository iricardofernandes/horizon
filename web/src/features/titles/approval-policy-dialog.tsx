'use client'

import { Dialog } from '@base-ui/react/dialog'
import { ShieldCheck, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TextField } from '@/components/ui/text-field'
import { apiError } from '@/lib/api'
import { minorUnits } from '@/lib/format'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { useMoney } from '@/lib/use-format'
import type { MutationProps } from './titles-view'
import { apiBaseOf, decimalOf, type TitlesData } from './types'

const CURRENCY = 'BRL'

/**
 * Up to what amount a payable posts without a second person. With no policy every payable
 * needs approval: the default is the strict one.
 */
export function ApprovalPolicyDialog({
  data,
  onChanged,
  setNotice,
}: { data: TitlesData } & MutationProps) {
  const t = useTranslations('payables')
  const common = useTranslations('common')
  const money = useMoney()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = data.approvalPolicies.find((policy) => policy.currency === CURRENCY)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const threshold = minorUnits(String(new FormData(event.currentTarget).get('threshold') ?? ''))
    if (threshold === null) {
      setError(t('invalidAmount'))
      return
    }
    setBusy(true)
    const response = await tracedFetch(
      'financial.payable.approval-policy',
      `${apiBaseOf('payable')}/approval-policies`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ currency: CURRENCY, threshold }),
      },
    )
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('actionFailed')))
      return
    }
    setOpen(false)
    setNotice(t('policySaved'))
    await onChanged()
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-secondary">
        <ShieldCheck aria-hidden="true" size={17} />
        {t('approvalPolicy')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <div className="dialog-heading">
            <Dialog.Title>{t('approvalPolicy')}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {current
                ? t('policyCurrent', { amount: money(current.threshold, CURRENCY) })
                : t('policyNone')}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <form className="dialog-form" onSubmit={submit}>
            <TextField
              defaultValue={current ? decimalOf(current.threshold) : ''}
              description={t('thresholdHelp')}
              inputMode="decimal"
              label={t('threshold')}
              name="threshold"
              pattern="[0-9]+([.,][0-9]{1,2})?"
              placeholder="0.00"
              required
            />
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
                {t('savePolicy')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
