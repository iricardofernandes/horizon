#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const inventoryRequire = createRequire(join(root, 'inventory/package.json'))
const salesRequire = createRequire(join(root, 'sales/package.json'))
const { PostgreSqlContainer } = inventoryRequire('@testcontainers/postgresql')
const { RabbitMQContainer } = inventoryRequire('@testcontainers/rabbitmq')
const postgres = inventoryRequire('postgres')
const { drizzle } = inventoryRequire('drizzle-orm/postgres-js')
const { migrate } = inventoryRequire('drizzle-orm/postgres-js/migrator')
const { connect } = inventoryRequire('amqplib')
const { trace } = salesRequire('@opentelemetry/api')
const { NodeSDK, tracing } = salesRequire('@opentelemetry/sdk-node')

const { InventoryDatabase } = inventoryRequire(
  join(root, 'inventory/dist/infrastructure/database/drizzle/inventory-database.js'),
)
const { InventorySalesEventHandlers } = inventoryRequire(
  join(root, 'inventory/dist/application/consume-sales-events.js'),
)
const {
  OutboxRelay: InventoryOutboxRelay,
  RabbitMqEventConsumer: InventoryConsumer,
  RabbitMqEventPublisher: InventoryPublisher,
} = inventoryRequire(
  join(root, 'inventory/dist/infrastructure/messaging/rabbitmq-transport.js'),
)
const { SalesDatabase } = salesRequire(
  join(root, 'sales/dist/infrastructure/database/drizzle/sales-database.js'),
)
const { SalesModuleEventHandlers } = salesRequire(
  join(root, 'sales/dist/application/consume-module-events.js'),
)
const { PlaceOrderUseCase } = salesRequire(
  join(root, 'sales/dist/application/use-cases/place-order.js'),
)
const {
  OutboxRelay: SalesOutboxRelay,
  RabbitMqEventConsumer: SalesConsumer,
  RabbitMqEventPublisher: SalesPublisher,
} = salesRequire(join(root, 'sales/dist/infrastructure/messaging/rabbitmq-transport.js'))

const exporter = new tracing.InMemorySpanExporter()
const telemetry = new NodeSDK({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
  logRecordProcessors: [],
  metricReaders: [],
})

const resources = []

async function databaseFixture(moduleName, migrationsFolder) {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase(`horizon_${moduleName}`)
    .withUsername('postgres')
    .withPassword('test')
    .start()
  resources.push(() => container.stop())
  const databaseName = `horizon_${moduleName}`
  await container.exec([
    'psql',
    '-U',
    'postgres',
    '-d',
    databaseName,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `CREATE ROLE horizon_owner LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_app LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_relay LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     ALTER DATABASE ${databaseName} OWNER TO horizon_owner;
     REVOKE ALL ON SCHEMA public FROM PUBLIC;
     GRANT USAGE ON SCHEMA public TO horizon_app, horizon_relay;`,
  ])
  const host = container.getHost()
  const port = container.getMappedPort(5432)
  const urls = {
    admin: container.getConnectionUri(),
    owner: `postgres://horizon_owner:test@${host}:${port}/${databaseName}`,
    app: `postgres://horizon_app:test@${host}:${port}/${databaseName}`,
    relay: `postgres://horizon_relay:test@${host}:${port}/${databaseName}`,
  }
  const migrationClient = postgres(urls.owner, { max: 1 })
  try {
    await migrate(drizzle(migrationClient), { migrationsFolder })
  } finally {
    await migrationClient.end()
  }
  return urls
}

async function waitFor(read, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function closeAll() {
  for (const close of resources.reverse()) {
    try {
      await close()
    } catch {
      // Preserve the primary test failure; every resource has an independent closer.
    }
  }
}

try {
  telemetry.start()
  resources.push(() => telemetry.shutdown())
  const [inventoryUrls, salesUrls, rabbit] = await Promise.all([
    databaseFixture(
      'inventory',
      join(root, 'inventory/src/infrastructure/database/drizzle/migrations'),
    ),
    databaseFixture('sales', join(root, 'sales/src/infrastructure/database/drizzle/migrations')),
    new RabbitMQContainer('rabbitmq:4-management-alpine').start(),
  ])
  resources.push(() => rabbit.stop())

  const inventoryDb = new InventoryDatabase({ url: inventoryUrls.app })
  const salesDb = new SalesDatabase({ url: salesUrls.app })
  const inventoryAdmin = postgres(inventoryUrls.admin, { max: 1 })
  const salesAdmin = postgres(salesUrls.admin, { max: 1 })
  resources.push(() => inventoryDb.close())
  resources.push(() => salesDb.close())
  resources.push(() => inventoryAdmin.end())
  resources.push(() => salesAdmin.end())

  const brokerUrl = rabbit.getAmqpUrl()
  const inventoryHandlers = new InventorySalesEventHandlers(
    inventoryDb,
    { now: () => new Date() },
    900,
  )
  const salesHandlers = new SalesModuleEventHandlers(salesDb, { now: () => new Date() })
  const inventoryConsumer = new InventoryConsumer({
    url: brokerUrl,
    queue: `phase7.inventory-${randomUUID()}`,
    handlers: inventoryHandlers.handlers,
    prefetch: 5,
  })
  const salesConsumer = new SalesConsumer({
    url: brokerUrl,
    queue: `phase7.sales-${randomUUID()}`,
    handlers: salesHandlers.handlers,
    prefetch: 5,
  })
  await Promise.all([inventoryConsumer.start(), salesConsumer.start()])
  resources.push(() => inventoryConsumer.close())
  resources.push(() => salesConsumer.close())

  const broker = await connect(brokerUrl)
  const sink = await broker.createChannel()
  const sinkQueue = (await sink.assertQueue('', { exclusive: true })).queue
  await sink.bindQueue(sinkQueue, 'horizon.events', 'sales.order.confirmed')
  await sink.bindQueue(sinkQueue, 'horizon.events', 'inventory.stock.moved')
  resources.push(() => sink.close())
  resources.push(() => broker.close())

  const inventoryPublisher = await InventoryPublisher.open(brokerUrl)
  const salesPublisher = await SalesPublisher.open(brokerUrl)
  const inventoryRelay = new InventoryOutboxRelay(inventoryUrls.relay, inventoryPublisher)
  const salesRelay = new SalesOutboxRelay(salesUrls.relay, salesPublisher)
  resources.push(() => inventoryRelay.close())
  resources.push(() => salesRelay.close())
  resources.push(() => inventoryPublisher.close())
  resources.push(() => salesPublisher.close())

  const tenantId = randomUUID()
  const itemId = randomUUID()
  const warehouseId = randomUUID()
  await Promise.all([inventoryDb.provisionTenant(tenantId), salesDb.provisionTenant(tenantId)])
  await inventoryAdmin`insert into warehouses (id, tenant_id, name, created_at, updated_at)
    values (${warehouseId}, ${tenantId}, 'Golden warehouse', now(), now())`
  await inventoryAdmin`insert into stock_balances
    (id, tenant_id, item_id, warehouse_id, on_hand, reserved, average_unit_cost, currency, version, updated_at)
    values (${randomUUID()}, ${tenantId}, ${itemId}, ${warehouseId}, 10000000, 0, 1250, 'BRL', 0, now())`
  await salesAdmin`insert into catalog_items
    (tenant_id, item_id, description, unit_price, currency, active, updated_at)
    values (${tenantId}, ${itemId}, 'Roasted coffee', 1250, 'BRL', 1, now())`

  let requestTraceId = ''
  let orderId = ''
  await trace.getTracer('phase7.e2e').startActiveSpan('sales.place-order', async (span) => {
    requestTraceId = span.spanContext().traceId
    try {
      const placed = await new PlaceOrderUseCase(salesDb, { now: () => new Date() }).execute({
        context: { tenantId, actor: 'system:phase7', requestId: null, idempotencyKey: randomUUID() },
        customerId: randomUUID(),
        fulfillmentWarehouseId: warehouseId,
        lines: [{ lineId: randomUUID(), itemId, quantity: '4' }],
      })
      if (placed.isLeft()) throw placed.value
      orderId = placed.value.orderId
    } finally {
      span.end()
    }
  })

  assert.equal(await salesRelay.flush(), 1)
  await waitFor(
    async () => {
      const [row] = await inventoryAdmin`select id from stock_reservations
        where tenant_id = ${tenantId} and order_id = ${orderId}`
      return row ?? null
    },
    'Inventory reservation',
  )

  const crashAfterPublish = new InventoryOutboxRelay(inventoryUrls.relay, {
    publish: async (event, traceParent) => {
      await inventoryPublisher.publish(event, traceParent)
      throw new Error('relay process killed after broker confirmation')
    },
  })
  try {
    await assert.rejects(() => crashAfterPublish.flush(), /relay process killed/)
  } finally {
    await crashAfterPublish.close()
  }
  await waitFor(
    async () => {
      const [row] = await salesAdmin`select status from sales_orders where id = ${orderId}`
      return row?.status === 'confirmed' ? row : null
    },
    'Sales confirmation',
  )
  assert.equal(await inventoryRelay.flush(), 1)
  await waitFor(
    async () => {
      const [row] = await salesAdmin`select count(*)::int as total from inbox
        where tenant_id = ${tenantId} and event_type = 'inventory.stock.reserved'`
      return row?.total === 1 ? row : null
    },
    'duplicate inbox acknowledgement',
  )

  assert.equal(await salesRelay.flush(), 1)
  await waitFor(
    async () => {
      const [row] = await inventoryAdmin`select status from stock_reservations
        where tenant_id = ${tenantId} and order_id = ${orderId}`
      return row?.status === 'confirmed' ? row : null
    },
    'Inventory hold committed',
  )

  // Committing the order commits the hold. The goods leave when a delivery leaves, which
  // is the fulfilment choreography rather than this one.
  const [balance] = await inventoryAdmin`select on_hand, reserved, version from stock_balances
    where tenant_id = ${tenantId} and item_id = ${itemId}`
  assert.deepEqual(balance, { on_hand: '10000000', reserved: '4000000', version: 0 })
  const [order] = await salesAdmin`select status, version, total, currency from sales_orders
    where id = ${orderId}`
  assert.deepEqual(order, { status: 'confirmed', version: 2, total: '5000', currency: 'BRL' })
  const salesInbox = await salesAdmin`select event_id from inbox
    where tenant_id = ${tenantId} and event_type = 'inventory.stock.reserved'`
  assert.equal(salesInbox.length, 1)
  const inventoryTraceIds = (
    await inventoryAdmin`select distinct trace_id from outbox where tenant_id = ${tenantId}`
  ).map((row) => row.trace_id)
  const salesTraceIds = (
    await salesAdmin`select distinct trace_id from outbox where tenant_id = ${tenantId}`
  ).map((row) => row.trace_id)
  assert.deepEqual(new Set([...inventoryTraceIds, ...salesTraceIds]), new Set([requestTraceId]))
  const flowSpans = exporter
    .getFinishedSpans()
    .filter((span) => span.spanContext().traceId === requestTraceId)
  assert(flowSpans.some((span) => span.name === 'outbox.publish'))
  assert(flowSpans.some((span) => span.name === 'inbox.consume'))

  console.log(
    JSON.stringify({
      ok: true,
      orderId,
      traceId: requestTraceId,
      salesInboxEffects: salesInbox.length,
      heldStock: balance.reserved,
    }),
  )
} finally {
  await closeAll()
}
