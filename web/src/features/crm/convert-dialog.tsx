'use client'

import { Dialog } from '@base-ui/react/dialog'
import { ArrowSquareOut, X } from '@phosphor-icons/react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Button } from '@/components/ui/button'
import { LoadingState, Notice } from '@/components/ui/state'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import { EMPTY_DRAFT, QuoteFields, quoteBody } from '@/features/sales/quote-form'
import { readJson, readPage } from '@/lib/api'
import { newKey, send } from './crm-data'
import { type Account, needsCustomerRole, type OpportunityDetail } from './types'

type Step = 'customer' | 'sales' | 'quote'
type StepState = 'waiting' | 'running' | 'done' | 'failed'

/** How long the screen waits for Sales to list a new customer before offering a retry. */
const CUSTOMER_WAIT_MS = 30_000

async function customerKnown(accountId: string): Promise<boolean> {
  const customers = await readJson<{ id: string }[]>(
    'sales.customers',
    '/api/horizon/sales/customers',
  )
  return customers.some((customer) => customer.id === accountId)
}

/**
 * "Convert to quote" (Phase 58): make the account a customer in Parties when it is still a
 * prospect, wait until Sales lists it, then write the quote for this opportunity. Sales
 * reads the owner and the source from its own projection; the screen only names the
 * opportunity. Each step shows where it stands, and a failed one can be tried again.
 */
export function ConvertDialog({
  opportunity,
  account,
  onClose,
  onConverted,
}: {
  opportunity: OpportunityDetail
  account: Account
  onClose: () => void
  onConverted: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const common = useTranslations('common')
  const setNotice = useNotice()
  const [items, setItems] = useState<CatalogItem[] | null>(null)
  const [itemsFailed, setItemsFailed] = useState(false)
  const [steps, setSteps] = useState<Record<Step, StepState>>({
    customer: needsCustomerRole(account) ? 'waiting' : 'done',
    sales: 'waiting',
    quote: 'waiting',
  })
  const [error, setError] = useState('')
  const [quoteId, setQuoteId] = useState<string | null>(null)
  // One key per conversion: a retry after a network failure never writes a second quote.
  const quoteKey = useRef(newKey())

  useEffect(() => {
    readPage<CatalogItem>('catalog.items', '/api/horizon/catalog/items?limit=100')
      .then((rows) => setItems(rows.filter((item) => item.active)))
      .catch(() => setItemsFailed(true))
  }, [])

  const mark = (step: Step, state: StepState) =>
    setSteps((current) => ({ ...current, [step]: state }))

  /** Run one step; a refusal marks it failed with the API's reason and stops the rest. */
  async function step(name: Step, work: () => Promise<string | null>): Promise<boolean> {
    mark(name, 'running')
    const refusal = await work()
    mark(name, refusal ? 'failed' : 'done')
    if (refusal) setError(refusal)
    return !refusal
  }

  const grantCustomer = async () => {
    const granted = await send(
      'parties.role.grant',
      'PUT',
      `/api/horizon/parties/parties/${account.id}/roles/customer`,
      {
        body: { operation: 'grant' },
        fallback: t('convert.grantFailed'),
      },
    )
    return granted.ok ? null : granted.error
  }

  const awaitCustomer = async () => {
    const deadline = Date.now() + CUSTOMER_WAIT_MS
    while (Date.now() < deadline) {
      if (await customerKnown(account.id).catch(() => false)) return null
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    return t('convert.salesTimeout')
  }

  const writeQuote = (body: ReturnType<typeof quoteBody>) => async () => {
    const written = await send<{ quoteId: string }>(
      'sales.quote.create',
      'POST',
      '/api/horizon/sales/quotes',
      {
        key: quoteKey.current,
        fallback: t('convert.quoteFailed'),
        body: { customerId: account.id, opportunityId: opportunity.id, ...body },
      },
    )
    if (!written.ok) return written.error
    setQuoteId(written.body.quoteId)
    return null
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const body = quoteBody(new FormData(event.currentTarget))
    setError('')
    if (steps.customer !== 'done' && !(await step('customer', grantCustomer))) return
    if (!(await step('sales', awaitCustomer))) return
    if (!(await step('quote', writeQuote(body)))) return
    setNotice(t('convert.done'))
    await onConverted()
  }

  const running = Object.values(steps).includes('running')
  return (
    <Dialog.Root onOpenChange={(open) => (open ? undefined : onClose())} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup quote-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{t('convert.title', { title: opportunity.title })}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('convert.description')}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <ol aria-label={t('convert.steps')} className="crm-steps">
            {(['customer', 'sales', 'quote'] as const).map((step) => (
              <li className={`crm-step crm-step-${steps[step]}`} key={step}>
                {t(`convert.step.${step}`)} — {t(`convert.state.${steps[step]}`)}
              </li>
            ))}
          </ol>
          <ConvertBody
            error={error}
            items={items}
            itemsFailed={itemsFailed}
            onSubmit={submit}
            partyFailed={steps.customer === 'failed'}
            quoteId={quoteId}
            running={running}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** What the dialog shows under the steps: the quote form, or where the conversion ended. */
function ConvertBody({
  quoteId,
  items,
  itemsFailed,
  error,
  partyFailed,
  running,
  onSubmit,
}: {
  quoteId: string | null
  items: CatalogItem[] | null
  itemsFailed: boolean
  error: string
  partyFailed: boolean
  running: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
}) {
  const t = useTranslations('crm')
  const common = useTranslations('common')
  if (quoteId)
    return (
      <div className="dialog-actions">
        <Link className="ui-button ui-button-primary" href={`/app/sales/quotes?open=${quoteId}`}>
          <ArrowSquareOut aria-hidden="true" size={17} />
          {t('convert.openQuote')}
        </Link>
      </div>
    )
  if (itemsFailed) return <Notice copy={t('convert.itemsUnavailable')} />
  if (!items) return <LoadingState />
  return (
    <form className="dialog-form" onSubmit={onSubmit}>
      <QuoteFields draft={EMPTY_DRAFT} items={items} />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {partyFailed ? (
        <Link className="crm-inline-link" href="/app/registrations/parties">
          {t('convert.openParty')}
        </Link>
      ) : null}
      <div className="dialog-actions">
        <Dialog.Close className="ui-button ui-button-secondary">{common('cancel')}</Dialog.Close>
        <Button disabled={running} type="submit" variant="primary">
          {error ? t('convert.retry') : t('convert.submit')}
        </Button>
      </div>
    </form>
  )
}
