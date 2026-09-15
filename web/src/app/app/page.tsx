'use client'

import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog } from '@base-ui/react/dialog'
import type { Icon } from '@phosphor-icons/react'
import {
  ArrowClockwise,
  ChartBar,
  Eye,
  FileText,
  Gear,
  Package,
  Plus,
  ShieldCheck,
  ShoppingCart,
  SidebarSimple,
  SignOut,
  Trash,
  UsersThree,
  Warehouse as WarehouseIcon,
  WebhooksLogo,
  X,
} from '@phosphor-icons/react'
import { useRouter } from 'next/navigation'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { AccessView, type WorkspaceUser } from '@/features/access/access-view'
import {
  CatalogView,
  type CatalogItem as Item,
  type CatalogPriceList as PriceList,
  type CatalogUnit as Unit,
} from '@/features/catalog/catalog-view'
import { InventoryView, type Warehouse } from '@/features/inventory/inventory-view'
import { type Customer, CustomersView } from '@/features/sales/customers-view'
import { type Quote, QuotesView } from '@/features/sales/quotes-view'
import { type ApiKeyRecord, SettingsView } from '@/features/settings/settings-view'
import { tracedFetch } from '@/lib/telemetry'

type User = {
  id: string
  name: string
  email: string
  workspace: { tenantId: string; slug: string; name: string } | null
}
type Order = {
  id: string
  status: string
  customerId: string
  fulfillmentWarehouseId: string
  total: { amount: string; currency: string } | null
  createdAt: string
  requestedLines: Array<{ lineId: string; itemId: string; quantity: string }>
  confirmedLines: Array<{
    lineId: string
    itemId: string
    description: string
    quantity: string
    lineTotal: { amount: string; currency: string }
  }>
}
type Subscription = {
  id: string
  endpointUrl: string
  eventTypes: string[]
  active: boolean
  createdAt?: string
}
type Delivery = {
  id: string
  subscriptionId: string
  eventId: string
  eventType: string
  status: string
  attemptCount: number
  nextAttemptAt: string | null
  lastResponseStatus: number | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}
type DeliveryAttempt = {
  id: string
  attemptNumber: number
  attemptedAt: string
  durationMs: number
  responseStatus: number | null
  error: string | null
}
type View =
  | 'overview'
  | 'catalog'
  | 'customers'
  | 'quotes'
  | 'inventory'
  | 'orders'
  | 'webhooks'
  | 'access'
  | 'settings'

const hostedDemo = process.env.NEXT_PUBLIC_HORIZON_HOSTED_DEMO === 'true'
const allNavigation: Array<{ id: View; label: string; icon: Icon }> = [
  { id: 'overview', label: 'Overview', icon: ChartBar },
  { id: 'catalog', label: 'Catalog', icon: Package },
  { id: 'customers', label: 'Customers', icon: UsersThree },
  { id: 'quotes', label: 'Quotes', icon: FileText },
  { id: 'inventory', label: 'Inventory', icon: WarehouseIcon },
  { id: 'orders', label: 'Orders', icon: ShoppingCart },
  { id: 'webhooks', label: 'Webhooks', icon: WebhooksLogo },
  { id: 'access', label: 'Access', icon: ShieldCheck },
  { id: 'settings', label: 'Settings', icon: Gear },
]
const nav = hostedDemo
  ? allNavigation.filter((item) => item.id === 'overview' || item.id === 'catalog')
  : allNavigation

export default function WorkspacePage() {
  const router = useRouter()
  const [view, setView] = useState<View>('overview')
  const [user, setUser] = useState<User | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [prices, setPrices] = useState<PriceList[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [workspaceUsers, setWorkspaceUsers] = useState<WorkspaceUser[]>([])
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const sidebar = sidebarPresentation(sidebarCollapsed)

  const load = useCallback(async () => {
    const coreEndpoints = [
      '/api/session',
      '/api/horizon/catalog/items?limit=100',
      '/api/horizon/catalog/price-lists?limit=100',
    ]
    const operationalEndpoints = [
      '/api/horizon/catalog/units?limit=100',
      '/api/horizon/identity/users?limit=100',
      '/api/horizon/identity/me/export',
      '/api/horizon/sales/customers',
      '/api/horizon/sales/quotes',
      '/api/horizon/inventory/warehouses',
      '/api/horizon/sales/orders',
      '/api/horizon/webhooks/webhook-subscriptions',
      '/api/horizon/webhooks/webhook-deliveries',
    ]
    const endpoints = hostedDemo ? coreEndpoints : [...coreEndpoints, ...operationalEndpoints]
    const responses = await Promise.all(
      endpoints.map((url) => tracedFetch('workspace.load', url, { cache: 'no-store' })),
    )
    if (responses[0]?.status === 401) {
      router.replace('/login')
      return
    }
    if (responses.some((response) => !response.ok)) throw new Error('Workspace data is unavailable')
    const [
      me,
      itemPage,
      pricePage,
      unitPage,
      userPage,
      identityExport,
      customerRows,
      quoteRows,
      warehouseRows,
      orderRows,
      hooks,
      attempts,
    ] = await Promise.all(responses.map((response) => response.json()))
    setUser(await resolveSessionUser(me as User))
    setItems(itemPage.data)
    setPrices(pricePage.data)
    if (!hostedDemo) {
      setUnits(unitPage.data)
      setWorkspaceUsers(userPage.data)
      setApiKeys(identityExport.apiKeys)
      setCustomers(customerRows)
      setQuotes(quoteRows)
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
    window.localStorage.removeItem('horizon.activeWorkspace')
    router.replace('/login')
  }

  return (
    <div className={sidebar.shellClassName}>
      <aside className="sidebar" id="workspace-sidebar">
        <a
          aria-label={`${user?.workspace?.name ?? 'Current'} workspace`}
          className="workspace-control"
          href="/workspaces"
        >
          <span className="brand-mark">
            {user?.workspace?.name.slice(0, 1).toUpperCase() ?? 'H'}
          </span>
          <span className="workspace-control-copy">
            <strong>{user?.workspace?.name ?? 'Workspace'}</strong>
            <small>Switch workspace</small>
          </span>
        </a>
        <p className="sidebar-section-label">Operations</p>
        <WorkspaceNavigation onChange={setView} view={view} />
      </aside>

      <main className="workspace-main">
        <header className="topbar">
          <div className="topbar-leading">
            <Button
              aria-controls="workspace-sidebar"
              aria-label={sidebar.controlLabel}
              aria-pressed={sidebarCollapsed}
              className="sidebar-toggle"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              title={sidebar.controlLabel}
              type="button"
            >
              <SidebarSimple aria-hidden="true" size={18} weight="bold" />
            </Button>
            <div>
              <p className="topbar-kicker">{user?.workspace?.name ?? 'Workspace'}</p>
              <strong>{nav.find((item) => item.id === view)?.label}</strong>
            </div>
          </div>
          <div className="user-menu">
            <span className="avatar">{user?.name?.slice(0, 1) ?? 'H'}</span>
            <span>
              <strong>{user?.name ?? 'Loading…'}</strong>
              <small>{user?.email ?? ''}</small>
            </span>
            <Button aria-label="Sign out" className="signout-button" onClick={logout} type="button">
              <SignOut aria-hidden="true" size={16} />
              <span>Sign out</span>
            </Button>
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
          {!loading ? (
            <CurrentView
              view={view}
              items={items}
              units={units}
              prices={prices}
              customers={customers}
              workspaceUsers={workspaceUsers}
              currentUserId={user?.id}
              quotes={quotes}
              warehouses={warehouses}
              orders={orders}
              subscriptions={subscriptions}
              deliveries={deliveries}
              apiKeys={apiKeys}
              user={user}
              onChanged={load}
              setNotice={setNotice}
            />
          ) : null}
        </div>
      </main>
    </div>
  )
}

function CurrentView({
  view,
  items,
  units,
  prices,
  customers,
  workspaceUsers,
  currentUserId,
  quotes,
  warehouses,
  orders,
  subscriptions,
  deliveries,
  apiKeys,
  user,
  onChanged,
  setNotice,
}: {
  view: View
  items: Item[]
  units: Unit[]
  prices: PriceList[]
  customers: Customer[]
  workspaceUsers: WorkspaceUser[]
  currentUserId: string | undefined
  quotes: Quote[]
  warehouses: Warehouse[]
  orders: Order[]
  subscriptions: Subscription[]
  deliveries: Delivery[]
  apiKeys: ApiKeyRecord[]
  user: User | null
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  if (view === 'overview')
    return (
      <Overview items={items} orders={orders} deliveries={deliveries} warehouses={warehouses} />
    )
  if (view === 'catalog')
    return (
      <CatalogView
        items={items}
        units={units}
        priceLists={prices}
        warehouses={warehouses}
        readOnly={hostedDemo}
        onChanged={onChanged}
        setNotice={setNotice}
      />
    )
  if (view === 'customers')
    return <CustomersView customers={customers} onChanged={onChanged} setNotice={setNotice} />
  if (view === 'quotes')
    return (
      <QuotesView
        quotes={quotes}
        customers={customers}
        items={items}
        onChanged={onChanged}
        setNotice={setNotice}
      />
    )
  if (view === 'inventory')
    return (
      <InventoryView
        items={items}
        warehouses={warehouses}
        onChanged={onChanged}
        setNotice={setNotice}
      />
    )
  if (view === 'orders')
    return (
      <Orders
        items={items}
        customers={customers}
        warehouses={warehouses}
        orders={orders}
        onChanged={onChanged}
        setNotice={setNotice}
      />
    )
  if (view === 'webhooks')
    return (
      <Webhooks
        subscriptions={subscriptions}
        deliveries={deliveries}
        onChanged={onChanged}
        setNotice={setNotice}
      />
    )
  if (view === 'access')
    return (
      <AccessView
        users={workspaceUsers}
        currentUserId={currentUserId}
        onChanged={onChanged}
        setNotice={setNotice}
      />
    )
  return (
    <SettingsView
      user={user}
      workspaceName={user?.workspace?.name ?? 'Workspace'}
      apiKeys={apiKeys}
      onChanged={onChanged}
      setNotice={setNotice}
    />
  )
}

function WorkspaceNavigation({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return (
    <nav aria-label="Workspace navigation">
      {nav.map((item) => {
        const NavigationIcon = item.icon
        const active = view === item.id
        return (
          <Button
            aria-current={active ? 'page' : undefined}
            className={active ? 'nav-item active' : 'nav-item'}
            key={item.id}
            onClick={() => onChange(item.id)}
            type="button"
            variant="navigation"
          >
            <span className="nav-glyph" aria-hidden="true">
              <NavigationIcon size={18} weight={active ? 'fill' : 'regular'} />
            </span>
            <span className="nav-label">{item.label}</span>
          </Button>
        )
      })}
    </nav>
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
  const [lines, setLines] = useState([0])
  const [nextLine, setNextLine] = useState(1)
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
    setLines([0])
    setNextLine(1)
    setBusy(false)
  }

  function addLine() {
    setLines((current) => [...current, nextLine])
    setNextLine((current) => current + 1)
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
          <SelectField
            label="Customer"
            name="customerId"
            options={customers
              .filter((row) => row.status === 'active')
              .map((row) => ({ label: row.name, value: row.id }))}
            required
          />
          <SelectField
            label="Warehouse"
            name="warehouseId"
            options={warehouses
              .filter((row) => row.active)
              .map((row) => ({ label: row.name, value: row.id }))}
            required
          />
          <div className="order-lines-heading">
            <strong>Order lines</strong>
            <Button
              disabled={lines.length >= 100}
              onClick={addLine}
              type="button"
              variant="secondary"
            >
              <Plus aria-hidden="true" size={15} /> Add line
            </Button>
          </div>
          <div className="order-lines">
            {lines.map((line, index) => (
              <div className="order-line" key={line}>
                <SelectField
                  label={`Item ${index + 1}`}
                  name="itemId"
                  options={items
                    .filter((row) => row.active)
                    .map((row) => ({ label: `${row.name} · ${row.sku}`, value: row.id }))}
                  required
                />
                <TextField
                  defaultValue="1"
                  inputMode="decimal"
                  label="Quantity"
                  name="quantity"
                  pattern="[0-9]+([.][0-9]{1,6})?"
                  required
                />
                <Button
                  aria-label={`Remove item ${index + 1}`}
                  className="remove-order-line"
                  disabled={lines.length === 1}
                  onClick={() => setLines((current) => current.filter((value) => value !== line))}
                  type="button"
                >
                  <Trash aria-hidden="true" size={16} />
                </Button>
              </div>
            ))}
          </div>
          <Button
            disabled={busy || !customers.length || !warehouses.length || !items.length}
            focusableWhenDisabled
            type="submit"
            variant="primary"
          >
            {busy ? 'Following the flow…' : 'Place order'}
          </Button>
        </form>
        <section className="panel">
          <PanelHeading title="Order history" copy={`${orders.length} most recent`} />
          <OrderTable orders={orders} customers={customers} warehouses={warehouses} />
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
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    const data = new FormData(event.currentTarget)
    const response = await tracedFetch(
      'webhook.create',
      '/api/horizon/webhooks/webhook-subscriptions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpointUrl: data.get('endpointUrl'),
          eventTypes: String(data.get('eventTypes') ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      },
    )
    if (!response.ok) {
      setNotice('The endpoint could not be registered. Use HTTPS outside local development.')
      setBusy(false)
      return
    }
    const created = await response.json()
    setSecret(created.secret)
    setNotice('Endpoint registered. Copy the signing secret now; it will not be shown again.')
    await onChanged()
    setBusy(false)
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
          <PanelHeading title="Add endpoint" copy="Select one or more event types" />
          <TextField
            label="Endpoint URL"
            name="endpointUrl"
            placeholder="https://example.com/horizon"
            required
            type="url"
          />
          <TextField
            defaultValue="sales.order.confirmed"
            description="Separate multiple event types with commas."
            label="Event types"
            name="eventTypes"
            required
          />
          <Button disabled={busy} type="submit" variant="primary">
            {busy ? 'Creating…' : 'Create subscription'}
          </Button>
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
                  <div className="row-actions">
                    <Badge status={row.active ? 'active' : 'inactive'} />
                    {row.active ? (
                      <DeleteSubscriptionDialog
                        subscription={row}
                        onChanged={onChanged}
                        setNotice={setNotice}
                      />
                    ) : null}
                  </div>
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
                <th aria-label="Actions" />
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
                  <td>
                    <div className="row-actions">
                      <DeliveryDetailsDialog delivery={row} />
                      {row.status === 'dead-letter' ? (
                        <ReplayDeliveryButton
                          delivery={row}
                          onChanged={onChanged}
                          setNotice={setNotice}
                        />
                      ) : null}
                    </div>
                  </td>
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

function DeleteSubscriptionDialog({
  subscription,
  onChanged,
  setNotice,
}: {
  subscription: Subscription
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function remove() {
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      'webhook.subscription.delete',
      `/api/horizon/webhooks/webhook-subscriptions/${subscription.id}`,
      { method: 'DELETE' },
    )
    if (!response.ok) {
      setError('The subscription could not be deactivated.')
      setBusy(false)
      return
    }
    setNotice('Webhook subscription deactivated.')
    await onChanged()
    setOpen(false)
    setBusy(false)
  }
  return (
    <AlertDialog.Root onOpenChange={setOpen} open={open}>
      <AlertDialog.Trigger
        aria-label={`Deactivate ${subscription.endpointUrl}`}
        className="ui-button ui-button-ghost icon-action danger-action"
      >
        <Trash aria-hidden="true" size={15} />
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-dialog-backdrop" />
        <AlertDialog.Popup className="ui-dialog-popup ui-alert-popup">
          <div className="dialog-heading">
            <AlertDialog.Title>Deactivate this endpoint?</AlertDialog.Title>
            <AlertDialog.Description className="dialog-description">
              New matching events will no longer be delivered to {subscription.endpointUrl}.
            </AlertDialog.Description>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <AlertDialog.Close className="ui-button ui-button-secondary">Cancel</AlertDialog.Close>
            <Button disabled={busy} onClick={remove} type="button" variant="danger">
              {busy ? 'Deactivating…' : 'Deactivate endpoint'}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

function DeliveryDetailsDialog({ delivery }: { delivery: Delivery }) {
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([])
  const [loading, setLoading] = useState(false)
  async function changed(open: boolean) {
    if (!open) return
    setLoading(true)
    const response = await tracedFetch(
      'webhook.delivery.attempts',
      `/api/horizon/webhooks/webhook-deliveries/${delivery.id}/attempts`,
    )
    if (response.ok) setAttempts(await response.json())
    setLoading(false)
  }
  return (
    <Dialog.Root onOpenChange={changed}>
      <Dialog.Trigger className="ui-button ui-button-ghost row-action-button">
        <Eye aria-hidden="true" size={15} /> Attempts
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup order-detail-dialog">
          <div className="dialog-heading">
            <Dialog.Title>Delivery attempts</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {delivery.eventType} · event {short(delivery.eventId)}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <div className="delivery-summary">
            <div>
              <span className="summary-label">Status</span>
              <Badge status={delivery.status} />
            </div>
            <div>
              <span className="summary-label">Last HTTP status</span>
              <strong>{delivery.lastResponseStatus ?? '—'}</strong>
            </div>
            <div>
              <span className="summary-label">Attempts</span>
              <strong>{delivery.attemptCount}</strong>
            </div>
          </div>
          <div className="attempt-list">
            {attempts.map((attempt) => (
              <article key={attempt.id}>
                <span className="attempt-number">#{attempt.attemptNumber}</span>
                <span>
                  <strong>
                    {attempt.responseStatus ? `HTTP ${attempt.responseStatus}` : 'Connection error'}
                  </strong>
                  <small>
                    {new Date(attempt.attemptedAt).toLocaleString()} · {attempt.durationMs} ms
                  </small>
                </span>
                <Badge status={attempt.error ? 'rejected' : 'succeeded'} />
                {attempt.error ? <p>{attempt.error}</p> : null}
              </article>
            ))}
            {loading ? <p className="empty">Loading attempts…</p> : null}
            {!loading && !attempts.length ? (
              <p className="empty">No delivery attempt has run yet.</p>
            ) : null}
          </div>
          <div className="dialog-actions">
            <Dialog.Close className="ui-button ui-button-secondary">Close</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ReplayDeliveryButton({
  delivery,
  onChanged,
  setNotice,
}: {
  delivery: Delivery
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const [busy, setBusy] = useState(false)
  async function replay() {
    setBusy(true)
    const response = await tracedFetch(
      'webhook.delivery.replay',
      `/api/horizon/webhooks/webhook-deliveries/${delivery.id}/replay`,
      { method: 'POST' },
    )
    setNotice(response.ok ? 'Delivery queued for replay.' : 'The delivery could not be replayed.')
    if (response.ok) await onChanged()
    setBusy(false)
  }
  return (
    <Button disabled={busy} onClick={replay} type="button">
      <ArrowClockwise aria-hidden="true" size={15} /> {busy ? 'Replaying…' : 'Replay'}
    </Button>
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
function OrderTable({
  orders,
  customers = [],
  warehouses = [],
}: {
  orders: Order[]
  customers?: Customer[]
  warehouses?: Warehouse[]
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Status</th>
            <th>Total</th>
            <th>Placed</th>
            <th aria-label="Actions" />
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
              <td>
                <OrderDetailsDialog
                  customer={customers.find((customer) => customer.id === row.customerId)}
                  order={row}
                  warehouse={warehouses.find(
                    (warehouse) => warehouse.id === row.fulfillmentWarehouseId,
                  )}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!orders.length ? <Empty copy="No orders yet. Place the first one from Orders." /> : null}
    </div>
  )
}

function OrderDetailsDialog({
  order,
  customer,
  warehouse,
}: {
  order: Order
  customer: Customer | undefined
  warehouse: Warehouse | undefined
}) {
  const lines = order.confirmedLines.length ? order.confirmedLines : order.requestedLines
  return (
    <Dialog.Root>
      <Dialog.Trigger className="ui-button ui-button-ghost row-action-button">
        <Eye aria-hidden="true" size={16} /> Details
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup order-detail-dialog">
          <div className="dialog-heading">
            <Dialog.Title>Order {short(order.id)}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              Created {new Date(order.createdAt).toLocaleString()}.
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <div className="order-detail-summary">
            <div>
              <span className="summary-label">Status</span>
              <Badge status={order.status} />
            </div>
            <div>
              <span className="summary-label">Customer</span>
              <strong>{customer?.name ?? short(order.customerId)}</strong>
            </div>
            <div>
              <span className="summary-label">Warehouse</span>
              <strong>{warehouse?.name ?? short(order.fulfillmentWarehouseId)}</strong>
            </div>
            <div>
              <span className="summary-label">Total</span>
              <strong>
                {order.total ? money(order.total.amount, order.total.currency) : 'Pending'}
              </strong>
            </div>
          </div>
          <div className="order-detail-lines">
            <h3>Lines</h3>
            {lines.map((line) => {
              const confirmed = isConfirmedOrderLine(line)
              return (
                <div key={line.lineId}>
                  <span>
                    <strong>{confirmed ? line.description : `Item ${short(line.itemId)}`}</strong>
                    <small className="detail-line-meta">Quantity {line.quantity}</small>
                  </span>
                  <strong>
                    {confirmed ? money(line.lineTotal.amount, line.lineTotal.currency) : 'Pending'}
                  </strong>
                </div>
              )
            })}
          </div>
          <div className="dialog-actions">
            <Dialog.Close className="ui-button ui-button-secondary">Close</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
function money(amount: string, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    Number(amount) / 100,
  )
}
function isConfirmedOrderLine(
  line: Order['confirmedLines'][number] | Order['requestedLines'][number],
): line is Order['confirmedLines'][number] {
  return 'lineTotal' in line
}
function compact(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  )
}
function short(id: string) {
  return id.slice(0, 8)
}

function locallyStoredWorkspace(): User['workspace'] {
  const value = window.localStorage.getItem('horizon.activeWorkspace')
  if (!value) return null
  try {
    const workspace = JSON.parse(value) as User['workspace']
    return workspace?.tenantId && workspace.slug && workspace.name ? workspace : null
  } catch {
    return null
  }
}

async function resolveSessionUser(user: User): Promise<User> {
  if (user.workspace) return user
  const refreshedSession = await tracedFetch('workspace.session.refresh', '/api/session', {
    cache: 'no-store',
  })
  if (refreshedSession.ok) {
    const refreshed = (await refreshedSession.json()) as User
    if (refreshed.workspace) return refreshed
  }
  const workspace = locallyStoredWorkspace()
  return workspace ? { ...user, workspace } : user
}

function sidebarPresentation(collapsed: boolean) {
  if (collapsed)
    return { shellClassName: 'workspace-shell sidebar-collapsed', controlLabel: 'Expand sidebar' }
  return { shellClassName: 'workspace-shell', controlLabel: 'Collapse sidebar' }
}

async function createOrder(data: FormData): Promise<{ orderId: string } | null> {
  const itemIds = data.getAll('itemId')
  const quantities = data.getAll('quantity')
  const response = await tracedFetch('order.create', '/api/horizon/sales/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({
      customerId: data.get('customerId'),
      fulfillmentWarehouseId: data.get('warehouseId'),
      lines: itemIds.map((itemId, index) => ({
        lineId: crypto.randomUUID(),
        itemId,
        quantity: quantities[index],
      })),
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
