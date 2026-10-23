'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { PageHeading, PanelHeading, Stat } from '@/components/ui/headings'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import type { Delivery } from '@/features/developers/deliveries-view'
import type { Warehouse } from '@/features/inventory/inventory-view'
import { type Order, OrderTable } from '@/features/sales/orders-view'

/** The part of the day a greeting names, by the reader's own clock. */
function periodOf(now: Date): 'morning' | 'afternoon' | 'evening' {
  const hour = now.getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  return 'evening'
}

export function OverviewView({
  items,
  orders,
  deliveries,
  warehouses,
}: {
  items: CatalogItem[]
  orders: Order[]
  deliveries: Delivery[]
  warehouses: Warehouse[]
}) {
  const t = useTranslations('overview')
  const format = useFormatter()
  const needsReview = deliveries.some((row) => row.status === 'dead-letter')
  const stock = warehouses
    .flatMap((warehouse) => warehouse.balances)
    .reduce((sum, row) => sum + Number(row.onHand), 0)
  return (
    <section>
      <PageHeading
        eyebrow={format.dateTime(new Date(), {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })}
        title={t('title', { period: periodOf(new Date()) })}
        copy={t('copy')}
      />
      <div className="stat-grid">
        <Stat
          label={t('activeItems')}
          value={format.number(items.filter((item) => item.active).length)}
          note={t('readyToSell')}
        />
        <Stat
          label={t('orders')}
          value={format.number(orders.length)}
          note={t('confirmedOrders', {
            count: orders.filter((order) => order.status === 'confirmed').length,
          })}
        />
        <Stat
          label={t('onHandUnits')}
          value={format.number(stock, { notation: 'compact', maximumFractionDigits: 1 })}
          note={t('acrossWarehouses')}
        />
        <Stat
          label={t('webhookHealth')}
          value={needsReview ? t('needsReview') : t('healthy')}
          note={t('recentDeliveries', { count: deliveries.length })}
          link={
            needsReview
              ? { href: '/app/developers/deliveries', label: t('openDeliveries') }
              : undefined
          }
        />
      </div>
      <div className="split-grid">
        <section className="panel">
          <PanelHeading title={t('recentOrders')} copy={t('liveFromSales')} />
          <OrderTable orders={orders.slice(0, 5)} />
        </section>
        <section className="panel quiet-panel">
          <PanelHeading title={t('rhythm')} copy={t('rhythmCopy')} />
          <ol className="flow-list">
            <li>
              <span aria-hidden="true">01</span>
              <div className="flow-copy">
                <strong>{t('flowOrderTitle')}</strong>
                <small>{t('flowOrderCopy')}</small>
              </div>
            </li>
            <li>
              <span aria-hidden="true">02</span>
              <div className="flow-copy">
                <strong>{t('flowStockTitle')}</strong>
                <small>{t('flowStockCopy')}</small>
              </div>
            </li>
            <li>
              <span aria-hidden="true">03</span>
              <div className="flow-copy">
                <strong>{t('flowCallbackTitle')}</strong>
                <small>{t('flowCallbackCopy')}</small>
              </div>
            </li>
          </ol>
        </section>
      </div>
    </section>
  )
}
