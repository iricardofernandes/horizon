'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { tracedFetch } from '@/lib/telemetry'

type User = { id: string; name: string; email: string }
type Item = { id: string; sku: string; name: string; kind: string; active: boolean }
type PriceList = { prices: Array<{ itemId: string; amount: string }>; currency: string }
type Customer = { id: string; name: string; email: string; status: string }
type Warehouse = {
  id: string
  name: string
  active: boolean
  balances: Array<{ itemId: string; onHand: string; reserved: string }>
}
type Order = {
  id: string
  status: string
  customerId: string
  fulfillmentWarehouseId: string
  total: { amount: string; currency: string } | null
  createdAt: string
  requestedLines: Array<{ itemId: string; quantity: string }>
  confirmedLines: Array<{
    description: string
    quantity: string
    lineTotal: { amount: string; currency: string }
  }>
}
type Subscription = { id: string; endpointUrl: string; eventTypes: string[]; active: boolean }
type Delivery = {
  id: string
  eventType: string
  status: string
  attemptCount: number
  updatedAt: string
}
type View = 'overview' | 'catalog' | 'orders' | 'webhooks'

const hostedDemo = process.env.NEXT_PUBLIC_HORIZON_HOSTED_DEMO === 'true'
const allNavigation: Array<{ id: View; label: string; glyph: string }> = [
  { id: 'overview', label: 'Overview', glyph: 'OV' },
  { id: 'catalog', label: 'Catalog', glyph: 'CA' },
  { id: 'orders', label: 'Orders', glyph: 'OR' },
  { id: 'webhooks', label: 'Webhooks', glyph: 'WH' },
]
const nav = hostedDemo
  ? allNavigation.filter((item) => item.id === 'overview' || item.id === 'catalog')
  : allNavigation

export default function WorkspacePage() {
  const router = useRouter()
  const [view, setView] = useState<View>('overview')
  const [user, setUser] = useState<User | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<PriceList[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const coreEndpoints = [
      '/api/session',
      '/api/horizon/catalog/items?limit=100',
      '/api/horizon/catalog/price-lists?limit=100',
    ]
    const operationalEndpoints = [
      '/api/horizon/sales/customers',
      '/api/horizon/inventory/warehouses',
      '/api/horizon/sales/orders',
      '/api/horizon/webhooks/webhook-subscriptions',
      '/api/horizon/webhooks/webhook-deliveries',
    ]
    const endpoints = hostedDemo ? coreEndpoints : [...coreEndpoints, ...operationalEndpoints]
    const responses = await Promise.all(endpoints.map((url) => tracedFetch('workspace.load', url)))
    if (responses[0]?.status === 401) {
      router.replace('/login')
      return
    }
    if (responses.some((response) => !response.ok)) throw new Error('Workspace data is unavailable')
    const [me, itemPage, pricePage, customerRows, warehouseRows, orderRows, hooks, attempts] =
      await Promise.all(responses.map((response) => response.json()))
    setUser(me)
    setItems(itemPage.data)
    setPrices(pricePage.data)
    if (!hostedDemo) {
      setCustomers(customerRows)
      setWarehouses(warehouseRows)
      setOrders(orderRows)
      setSubscriptions(hooks)
      setDeliveries(attempts)
    }
    setLoading(false)
  }, [router])

  useEffect(() => {
    load().catch(() => {
      setNotice(
        'The workspace could not be loaded. Check that the application services are running.',
      )
      setLoading(false)
    })
  }, [load])

  async function logout() {
    await tracedFetch('session.logout', '/api/session', { method: 'DELETE' })
    router.replace('/login')
  }

  const priceByItem = useMemo(
    () =>
      new Map(
        prices.flatMap((list) =>
          list.prices.map((price) => [price.itemId, { ...price, currency: list.currency }]),
        ),
      ),
    [prices],
  )

  return (
    <div className="workspace-shell">
      <aside className="sidebar">
        <a className="brand" href="/app">
          <span className="brand-mark">H</span>
          <span>Horizon</span>
        </a>
        <nav aria-label="Workspace navigation">
          {nav.map((item) => (
            <button
              className={view === item.id ? 'nav-item active' : 'nav-item'}
              key={item.id}
              onClick={() => setView(item.id)}
              type="button"
            >
              <span className="nav-glyph" aria-hidden="true">
                {item.glyph}
              </span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="pulse-dot" />
          All systems operational
        </div>
      </aside>

      <main className="workspace-main">
        <header className="topbar">
          <div>
            <p className="topbar-kicker">Horizon Demo</p>
            <strong>{nav.find((item) => item.id === view)?.label}</strong>
          </div>
          <div className="user-menu">
            <span className="avatar">{user?.name?.slice(0, 1) ?? 'H'}</span>
            <span>
              <strong>{user?.name ?? 'Loading…'}</strong>
              <small>{user?.email ?? ''}</small>
            </span>
            <button className="text-button" onClick={logout} type="button">
              Sign out
            </button>
          </div>
        </header>
        <div className="content">
          {hostedDemo ? (
            <div className="notice" role="status">
              Public demo profile: live session and Catalog on Neon. The asynchronous order
              choreography remains available in the full local stack.
            </div>
          ) : null}
          {notice ? (
            <div className="notice" role="status">
              {notice}
            </div>
          ) : null}
          {loading ? <LoadingState /> : null}
          {!loading && view === 'overview' ? (
            <Overview
              items={items}
              orders={orders}
              deliveries={deliveries}
              warehouses={warehouses}
            />
          ) : null}
          {!loading && view === 'catalog' ? (
            <Catalog items={items} warehouses={warehouses} priceByItem={priceByItem} />
          ) : null}
          {!loading && view === 'orders' ? (
            <Orders
              items={items}
              customers={customers}
              warehouses={warehouses}
              orders={orders}
              onChanged={load}
              setNotice={setNotice}
            />
          ) : null}
          {!loading && view === 'webhooks' ? (
            <Webhooks
              subscriptions={subscriptions}
              deliveries={deliveries}
              onChanged={load}
              setNotice={setNotice}
            />
          ) : null}
        </div>
      </main>
    </div>
  )
}

function Overview({
  items,
  orders,
  deliveries,
  warehouses,
}: {
  items: Item[]
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

function Catalog({
  items,
  warehouses,
  priceByItem,
}: {
  items: Item[]
  warehouses: Warehouse[]
  priceByItem: Map<string, { amount: string; currency: string }>
}) {
  return (
    <section>
      <PageHeading
        eyebrow="Commercial foundation"
        title="Catalog"
        copy="Items, prices and availability in one view."
      />
      <div className="panel table-panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>SKU</th>
                <th>Type</th>
                <th>Price</th>
                <th>Available</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const price = priceByItem.get(item.id)
                const balance = warehouses
                  .flatMap((row) => row.balances)
                  .find((row) => row.itemId === item.id)
                return (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.name}</strong>
                    </td>
                    <td>
                      <code className="table-code">{item.sku}</code>
                    </td>
                    <td className="capitalize">{item.kind}</td>
                    <td>{price ? money(price.amount, price.currency) : '—'}</td>
                    <td>{balance?.onHand ?? '0'}</td>
                    <td>
                      <Badge status={item.active ? 'active' : 'inactive'} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function Orders({
  items,
  customers,
  warehouses,
  orders,
  onChanged,
  setNotice,
}: {
  items: Item[]
  customers: Customer[]
  warehouses: Warehouse[]
  orders: Order[]
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    const data = new FormData(event.currentTarget)
    const created = await createOrder(data)
    if (!created) {
      setNotice('The order could not be placed. Verify stock and permissions.')
      setBusy(false)
      return
    }
    setNotice(`Order ${short(created.orderId)} was placed. Waiting for Inventory confirmation…`)
    const status = await waitForOrder(created.orderId)
    setNotice(
      status === 'confirmed'
        ? 'Order confirmed and stock committed.'
        : status === 'rejected'
          ? 'Order rejected because stock was unavailable.'
          : 'The order is still processing. Its status will remain visible here.',
    )
    await onChanged()
    setBusy(false)
  }
  return (
    <section>
      <PageHeading
        eyebrow="Sales workspace"
        title="Orders"
        copy="Place an order and watch the asynchronous stock decision arrive."
      />
      <div className="split-grid order-layout">
        <form className="panel form-panel" onSubmit={submit}>
          <PanelHeading title="New order" copy="One line is enough for the golden path" />
          <label>
            Customer
            <select name="customerId" required>
              {customers
                .filter((row) => row.status === 'active')
                .map((row) => (
                  <option value={row.id} key={row.id}>
                    {row.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Warehouse
            <select name="warehouseId" required>
              {warehouses
                .filter((row) => row.active)
                .map((row) => (
                  <option value={row.id} key={row.id}>
                    {row.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Item
            <select name="itemId" required>
              {items
                .filter((row) => row.active)
                .map((row) => (
                  <option value={row.id} key={row.id}>
                    {row.name} · {row.sku}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Quantity
            <input
              name="quantity"
              inputMode="decimal"
              defaultValue="1"
              pattern="[0-9]+([.][0-9]{1,6})?"
              required
            />
          </label>
          <button
            className="primary-button"
            disabled={busy || !customers.length || !warehouses.length || !items.length}
            type="submit"
          >
            {busy ? 'Following the flow…' : 'Place order'}
          </button>
        </form>
        <section className="panel">
          <PanelHeading title="Order history" copy={`${orders.length} most recent`} />
          <OrderTable orders={orders} />
        </section>
      </div>
    </section>
  )
}

function Webhooks({
  subscriptions,
  deliveries,
  onChanged,
  setNotice,
}: {
  subscriptions: Subscription[]
  deliveries: Delivery[]
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const [secret, setSecret] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const response = await tracedFetch(
      'webhook.create',
      '/api/horizon/webhooks/webhook-subscriptions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpointUrl: data.get('endpointUrl'),
          eventTypes: ['sales.order.confirmed'],
        }),
      },
    )
    if (!response.ok) {
      setNotice('The endpoint could not be registered. Use HTTPS outside local development.')
      return
    }
    const created = await response.json()
    setSecret(created.secret)
    setNotice('Endpoint registered. Copy the signing secret now; it will not be shown again.')
    await onChanged()
  }
  return (
    <section>
      <PageHeading
        eyebrow="Developer operations"
        title="Webhooks"
        copy="Deliver order events to the systems that depend on them."
      />
      <div className="split-grid">
        <form className="panel form-panel" onSubmit={submit}>
          <PanelHeading title="Add endpoint" copy="Subscribed to sales.order.confirmed" />
          <label>
            Endpoint URL
            <input
              name="endpointUrl"
              type="url"
              placeholder="https://example.com/horizon"
              required
            />
          </label>
          <button className="primary-button" type="submit">
            Create subscription
          </button>
          {secret ? (
            <div className="secret-box">
              <small>Signing secret · shown once</small>
              <code>{secret}</code>
            </div>
          ) : null}
        </form>
        <section className="panel">
          <PanelHeading
            title="Subscriptions"
            copy={`${subscriptions.filter((row) => row.active).length} active`}
          />
          <div className="stack-list">
            {subscriptions.length ? (
              subscriptions.map((row) => (
                <div className="stack-row" key={row.id}>
                  <div className="stack-copy">
                    <strong>{row.endpointUrl}</strong>
                    <small>{row.eventTypes.join(', ')}</small>
                  </div>
                  <Badge status={row.active ? 'active' : 'inactive'} />
                </div>
              ))
            ) : (
              <Empty copy="No endpoints registered yet." />
            )}
          </div>
        </section>
      </div>
      <section className="panel delivery-panel">
        <PanelHeading title="Recent deliveries" copy="Attempt status from the durable queue" />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((row) => (
                <tr key={row.id}>
                  <td>
                    <code className="table-code">{row.eventType}</code>
                  </td>
                  <td>
                    <Badge status={row.status} />
                  </td>
                  <td>{row.attemptCount}</td>
                  <td>{new Date(row.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!deliveries.length ? <Empty copy="Deliveries appear after a confirmed order." /> : null}
        </div>
      </section>
    </section>
  )
}

function PageHeading({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return (
    <header className="page-heading">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{copy}</p>
    </header>
  )
}
function PanelHeading({ title, copy }: { title: string; copy: string }) {
  return (
    <header className="panel-heading">
      <div>
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>
    </header>
  )
}
function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  )
}
function Badge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status.replace('-', ' ')}</span>
}
function Empty({ copy }: { copy: string }) {
  return <p className="empty">{copy}</p>
}
function LoadingState() {
  return (
    <div className="loading" aria-live="polite">
      <span className="loading-mark">H</span>
      <p>Preparing your workspace…</p>
    </div>
  )
}
function OrderTable({ orders }: { orders: Order[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Status</th>
            <th>Total</th>
            <th>Placed</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((row) => (
            <tr key={row.id}>
              <td>
                <code className="table-code">{short(row.id)}</code>
              </td>
              <td>
                <Badge status={row.status} />
              </td>
              <td>{row.total ? money(row.total.amount, row.total.currency) : 'Pending'}</td>
              <td>{new Date(row.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!orders.length ? <Empty copy="No orders yet. Place the first one from Orders." /> : null}
    </div>
  )
}
function money(amount: string, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    Number(amount) / 100,
  )
}
function compact(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  )
}
function short(id: string) {
  return id.slice(0, 8)
}

async function createOrder(data: FormData): Promise<{ orderId: string } | null> {
  const response = await tracedFetch('order.create', '/api/horizon/sales/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({
      customerId: data.get('customerId'),
      fulfillmentWarehouseId: data.get('warehouseId'),
      lines: [
        {
          lineId: crypto.randomUUID(),
          itemId: data.get('itemId'),
          quantity: data.get('quantity'),
        },
      ],
    }),
  })
  return response.ok ? ((await response.json()) as { orderId: string }) : null
}

async function waitForOrder(orderId: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    const response = await tracedFetch('order.poll', `/api/horizon/sales/orders/${orderId}`)
    if (!response.ok) continue
    const order = (await response.json()) as Order
    if (order.status === 'confirmed' || order.status === 'rejected') return order.status
  }
  return 'placed'
}
