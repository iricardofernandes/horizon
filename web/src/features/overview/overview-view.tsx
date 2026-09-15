'use client'

import { PageHeading, PanelHeading, Stat } from '@/components/ui/headings'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import type { Delivery } from '@/features/developers/deliveries-view'
import type { Warehouse } from '@/features/inventory/inventory-view'
import { type Order, OrderTable } from '@/features/sales/orders-view'
import { compact } from '@/lib/format'

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
  const stock = warehouses
    .flatMap((warehouse) => warehouse.balances)
    .reduce((sum, row) => sum + Number(row.onHand), 0)
  return (
    <section>
      <PageHeading
        eyebrow="Monday, September 14"
        title="Good afternoon"
        copy="Here is the shape of your operation right now."
      />
      <div className="stat-grid">
        <Stat
          label="Active items"
          value={String(items.filter((item) => item.active).length)}
          note="Ready to sell"
        />
        <Stat
          label="Orders"
          value={String(orders.length)}
          note={`${orders.filter((order) => order.status === 'confirmed').length} confirmed`}
        />
        <Stat label="On-hand units" value={compact(stock)} note="Across all warehouses" />
        <Stat
          label="Webhook health"
          value={
            deliveries.some((row) => row.status === 'dead-letter') ? 'Needs review' : 'Healthy'
          }
          note={`${deliveries.length} recent deliveries`}
        />
      </div>
      <div className="split-grid">
        <section className="panel">
          <PanelHeading title="Recent orders" copy="Live from Sales" />{' '}
          <OrderTable orders={orders.slice(0, 5)} />
        </section>
        <section className="panel quiet-panel">
          <PanelHeading title="Operational rhythm" copy="The flow behind every order" />
          <ol className="flow-list">
            <li>
              <span>01</span>
              <div className="flow-copy">
                <strong>Order placed</strong>
                <small>Sales snapshots the request</small>
              </div>
            </li>
            <li>
              <span>02</span>
              <div className="flow-copy">
                <strong>Stock reserved</strong>
                <small>Inventory confirms availability</small>
              </div>
            </li>
            <li>
              <span>03</span>
              <div className="flow-copy">
                <strong>Callback signed</strong>
                <small>Webhooks notifies your system</small>
              </div>
            </li>
          </ol>
        </section>
      </div>
    </section>
  )
}
