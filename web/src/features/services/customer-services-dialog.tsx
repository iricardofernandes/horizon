'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Briefcase, X } from '@phosphor-icons/react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Empty, LoadingState, Notice } from '@/components/ui/state'
import { reference } from '@/features/sales/types'
import { readJson } from '@/lib/api'
import { useStatusLabel } from '@/lib/status'
import { useDate, useMoney } from '@/lib/use-format'
import {
  type Contract,
  customerServices,
  periodAmount,
  revisionInForce,
  SALES_API,
  type ServiceOrder,
  utcToday,
} from './types'

type Found = { orders: ServiceOrder[]; contracts: Contract[] }

/** One customer's service orders and contracts, read when asked for. */
export function CustomerServicesDialog({ customerId, name }: { customerId: string; name: string }) {
  const t = useTranslations('services')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [found, setFound] = useState<Found | null>(null)
  const [failed, setFailed] = useState(false)

  async function load() {
    try {
      const [orders, contracts] = await Promise.all([
        readJson<ServiceOrder[]>('sales.service-orders', `${SALES_API}/service-orders`),
        readJson<Contract[]>('sales.contracts', `${SALES_API}/contracts`),
      ])
      setFound(customerServices(customerId, orders, contracts))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }

  return (
    <Dialog.Root
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void load()
      }}
      open={open}
    >
      <Dialog.Trigger
        aria-label={t('customerServices.open', { name })}
        className="ui-button ui-button-secondary"
      >
        <Briefcase aria-hidden="true" size={16} />
        {t('customerServices.button')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup document-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{t('customerServices.title', { name })}</Dialog.Title>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {failed ? <Notice copy={t('detailUnavailable')} /> : null}
          {!failed && !found ? <LoadingState /> : null}
          {found ? <Lists found={found} /> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Lists({ found }: { found: Found }) {
  const t = useTranslations('services')
  const label = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  const today = utcToday()
  return (
    <>
      <h3 className="document-section-title">{t('customerServices.orders')}</h3>
      {found.orders.length === 0 ? (
        <Empty copy={t('customerServices.noOrders')} />
      ) : (
        <ul className="customer-services-list">
          {found.orders.map((order) => (
            <li key={order.id}>
              <code>{reference('OS', order.id)}</code>{' '}
              <Badge label={label(order.status)} status={order.status} /> ·{' '}
              {money(order.total, order.currency)} · {date(order.openedOn)}
            </li>
          ))}
        </ul>
      )}
      <h3 className="document-section-title">{t('customerServices.contracts')}</h3>
      {found.contracts.length === 0 ? (
        <Empty copy={t('customerServices.noContracts')} />
      ) : (
        <ul className="customer-services-list">
          {found.contracts.map((contract) => {
            const revision = revisionInForce(contract.revisions, today) ?? contract.revisions[0]
            return (
              <li key={contract.id}>
                <code>{reference('CTR', contract.id)}</code>{' '}
                <Badge label={label(contract.status)} status={contract.status} /> ·{' '}
                {revision ? t(`recurrence.${revision.recurrence}`) : '—'} ·{' '}
                {revision ? money(periodAmount(revision), contract.currency) : '—'}
              </li>
            )
          })}
        </ul>
      )}
      <p className="document-note">
        <Link href="/app/sales/service-orders">{t('customerServices.goOrders')}</Link> ·{' '}
        <Link href="/app/sales/contracts">{t('customerServices.goContracts')}</Link>
      </p>
    </>
  )
}
