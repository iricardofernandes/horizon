#!/usr/bin/env node

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const inventoryRequire = createRequire(join(root, 'inventory/package.json'))
const salesRequire = createRequire(join(root, 'sales/package.json'))
const webhooksRequire = createRequire(join(root, 'webhooks/package.json'))
const postgres = salesRequire('postgres')
const { connect } = salesRequire('amqplib')
const { trace } = salesRequire('@opentelemetry/api')
const { NodeSDK } = salesRequire('@opentelemetry/sdk-node')
const { OTLPTraceExporter } = salesRequire('@opentelemetry/exporter-trace-otlp-http')

const env = await loadEnv(join(root, 'infra/.env'))
const configured = (name, fallback) => process.env[name] ?? env[name] ?? fallback
const postgresPort = configured('HORIZON_POSTGRES_PORT', '5432')
const rabbitPort = configured('HORIZON_RABBITMQ_PORT', '5672')
const otlpPort = configured('HORIZON_OTLP_HTTP_PORT', '4318')
const listenPort = Number(configured('HORIZON_BENCHMARK_PORT', '3939'))
const rabbitUrl = `amqp://horizon:horizon@localhost:${rabbitPort}`
const databaseUrl = (role, module) =>
  `postgres://${role}:horizon@localhost:${postgresPort}/horizon_${module}`
const resources = []
let stopping = false
let pumpInFlight
let webhookPumpInFlight

const telemetry = new NodeSDK({
  serviceName: 'sales',
  traceExporter: new OTLPTraceExporter({ url: `http://localhost:${otlpPort}/v1/traces` }),
  logRecordProcessors: [],
  metricReaders: [],
})
telemetry.start()

try {
  const modules = loadModules()
  const clock = { now: () => new Date() }
  const inventoryDb = new modules.InventoryDatabase({
    url: databaseUrl('horizon_app', 'inventory'),
    poolMax: 20,
  })
  const salesDb = new modules.SalesDatabase({
    url: databaseUrl('horizon_app', 'sales'),
    poolMax: 20,
    customerPrivacy: {
      secretBox: new modules.SalesSecretBox(),
      blindIndexKey: Buffer.from('0'.repeat(64)),
    },
  })
  const webhooksDb = new modules.WebhookDatabase({
    appUrl: databaseUrl('horizon_app', 'webhooks'),
    workerUrl: databaseUrl('horizon_relay', 'webhooks'),
    encryptionKey: Buffer.alloc(32),
  })
  const identityAdmin = postgres(
    `postgres://postgres:postgres@localhost:${postgresPort}/horizon_identity`,
    { max: 1 },
  )
  const catalogAdmin = postgres(
    `postgres://postgres:postgres@localhost:${postgresPort}/horizon_catalog`,
    { max: 1 },
  )
  const inventoryAdmin = postgres(
    `postgres://postgres:postgres@localhost:${postgresPort}/horizon_inventory`,
    { max: 10 },
  )
  const salesAdmin = postgres(
    `postgres://postgres:postgres@localhost:${postgresPort}/horizon_sales`,
    { max: 10 },
  )
  resources.push(() => identityAdmin.end())
  resources.push(() => catalogAdmin.end())
  resources.push(() => inventoryAdmin.end())
  resources.push(() => salesAdmin.end())
  resources.push(() => inventoryDb.close())
  resources.push(() => salesDb.close())
  resources.push(() => webhooksDb.close())

  const fixture = await readFixture(
    identityAdmin,
    catalogAdmin,
    inventoryAdmin,
    salesAdmin,
  )
  const inventoryHandlers = new modules.InventorySalesEventHandlers(inventoryDb, clock, 1800)
  const salesHandlers = new modules.SalesModuleEventHandlers(salesDb, clock)
  const queueSuffix = `${process.pid}.${randomUUID()}`
  const inventoryQueue = `horizon.benchmark.inventory.${queueSuffix}`
  const salesQueue = `horizon.benchmark.sales.${queueSuffix}`
  const webhooksQueue = `horizon.benchmark.webhooks.${queueSuffix}`
  const inventoryConsumer = new modules.InventoryConsumer({
    url: rabbitUrl,
    queue: inventoryQueue,
    handlers: inventoryHandlers.handlers,
    prefetch: 100,
  })
  const salesConsumer = new modules.SalesConsumer({
    url: rabbitUrl,
    queue: salesQueue,
    handlers: salesHandlers.handlers,
    prefetch: 100,
  })
  const webhooksConsumer = new modules.WebhookEventConsumer({
    url: rabbitUrl,
    queue: webhooksQueue,
    repository: webhooksDb,
    prefetch: 100,
  })
  await Promise.all([
    inventoryConsumer.start(),
    salesConsumer.start(),
    webhooksConsumer.start(),
  ])
  resources.push(() =>
    deleteQueues(rabbitUrl, [
      inventoryQueue,
      salesQueue,
      webhooksQueue,
      `${webhooksQueue}.dlq`,
    ]),
  )
  resources.push(() => inventoryConsumer.close())
  resources.push(() => salesConsumer.close())
  resources.push(() => webhooksConsumer.close())

  const broker = await connect(rabbitUrl)
  const sink = await broker.createChannel()
  const sinkQueue = (await sink.assertQueue('', { exclusive: true })).queue
  const confirmedEvents = new Map()
  for (const eventType of [
    'sales.order.confirmed',
    'sales.invoicing.requested',
    'inventory.stock.moved',
  ])
    await sink.bindQueue(sinkQueue, 'horizon.events', eventType)
  await sink.consume(sinkQueue, (message) => {
    if (!message) return
    const event = JSON.parse(message.content.toString())
    if (event.eventType === 'sales.order.confirmed')
      confirmedEvents.set(event.payload.orderId, event)
    sink.ack(message)
  })
  resources.push(() => sink.close())
  resources.push(() => broker.close())

  const inventoryPublisher = await modules.InventoryPublisher.open(rabbitUrl)
  const salesPublisher = await modules.SalesPublisher.open(rabbitUrl)
  const inventoryRelay = new modules.InventoryOutboxRelay(
    databaseUrl('horizon_relay', 'inventory'),
    inventoryPublisher,
    1000,
  )
  const salesRelay = new modules.SalesOutboxRelay(
    databaseUrl('horizon_relay', 'sales'),
    salesPublisher,
    1000,
  )
  resources.push(() => inventoryRelay.close())
  resources.push(() => salesRelay.close())
  resources.push(() => inventoryPublisher.close())
  resources.push(() => salesPublisher.close())

  const callback = await startCallbackReceiver()
  resources.push(callback.close)
  await webhooksDb.provisionTenant(fixture.tenantId)
  const existingSubscription = (await webhooksDb.listSubscriptions(fixture.tenantId)).find(
    (subscription) => subscription.active && subscription.endpointUrl === callback.url,
  )
  const subscription = existingSubscription
    ? { subscriptionId: existingSubscription.id, secret: existingSubscription.secret }
    : await new modules.CreateSubscriptionUseCase(webhooksDb, clock).execute({
        tenantId: fixture.tenantId,
        endpointUrl: callback.url,
        eventTypes: ['sales.order.confirmed'],
      })
  callback.setSecret(subscription.secret)
  const webhookDispatcher = new modules.WebhookDispatcher(
    webhooksDb,
    new modules.FetchWebhookClient(),
    clock,
    { maxAttempts: 3, baseMs: 50, maxMs: 1000, jitterRatio: 0 },
    { timeoutMs: 5000, batchSize: 100, queueDepthAlert: 10_000 },
    () => 0.5,
  )
  const placeOrder = new modules.PlaceOrderUseCase(salesDb, clock)
  const api = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      return
    }
    if (request.method !== 'POST' || request.url !== '/orders') {
      response.writeHead(404).end()
      return
    }
    const startedAt = performance.now()
    try {
      const result = await trace
        .getTracer('horizon.benchmark')
        .startActiveSpan('golden-path', async (span) => {
          try {
            const placed = await placeOrder.execute({
              tenantId: fixture.tenantId,
              customerId: fixture.customerId,
              fulfillmentWarehouseId: fixture.warehouseId,
              lines: [
                { lineId: randomUUID(), itemId: fixture.itemId, quantity: '4' },
              ],
            })
            if (placed.isLeft()) throw placed.value
            await converge(
              placed.value.orderId,
              fixture.tenantId,
              salesRelay,
              inventoryRelay,
              salesAdmin,
              inventoryAdmin,
            )
            const event = await waitFor(
              () => confirmedEvents.get(placed.value.orderId) ?? null,
              'confirmed event at the broker sink',
            )
            await waitFor(async () => {
              await pumpWebhooks(webhookDispatcher)
              return callback.has(event.eventId) ? true : null
            }, 'confirmed event at the signed callback')
            confirmedEvents.delete(placed.value.orderId)
            return { orderId: placed.value.orderId, traceId: span.spanContext().traceId }
          } finally {
            span.end()
          }
        })
      response
        .writeHead(201, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({
            ok: true,
            ...result,
            durationMs: Number((performance.now() - startedAt).toFixed(2)),
          }),
        )
    } catch (error) {
      response
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'error' }))
    }
  })
  await new Promise((resolve, reject) => {
    api.once('error', reject)
    api.listen(listenPort, '127.0.0.1', resolve)
  })
  resources.push(() => new Promise((resolve) => api.close(resolve)))
  console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${listenPort}` }))

  const stop = async () => {
    if (stopping) return
    stopping = true
    await closeAll()
    await telemetry.shutdown().catch(() => undefined)
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await new Promise(() => undefined)
} catch (error) {
  await closeAll()
  await telemetry.shutdown().catch(() => undefined)
  throw error
}

function loadModules() {
  const from = (require, path) => require(join(root, path))
  const inventory = {
    ...from(inventoryRequire, 'inventory/dist/infrastructure/database/drizzle/inventory-database.js'),
    ...from(inventoryRequire, 'inventory/dist/application/consume-sales-events.js'),
    ...from(inventoryRequire, 'inventory/dist/infrastructure/messaging/rabbitmq-transport.js'),
  }
  const sales = {
    ...from(salesRequire, 'sales/dist/infrastructure/database/drizzle/sales-database.js'),
    ...from(salesRequire, 'sales/dist/infrastructure/cryptography/aes-gcm-secret-box.js'),
    ...from(salesRequire, 'sales/dist/application/consume-module-events.js'),
    ...from(salesRequire, 'sales/dist/application/use-cases/place-order.js'),
    ...from(salesRequire, 'sales/dist/infrastructure/messaging/rabbitmq-transport.js'),
  }
  const webhooks = {
    ...from(webhooksRequire, 'webhooks/dist/infrastructure/database/webhook-database.js'),
    ...from(webhooksRequire, 'webhooks/dist/application/webhook-service.js'),
    ...from(webhooksRequire, 'webhooks/dist/infrastructure/http/fetch-webhook-client.js'),
    ...from(webhooksRequire, 'webhooks/dist/infrastructure/messaging/event-consumer.js'),
  }
  return {
    InventoryDatabase: inventory.InventoryDatabase,
    InventorySalesEventHandlers: inventory.InventorySalesEventHandlers,
    InventoryConsumer: inventory.RabbitMqEventConsumer,
    InventoryPublisher: inventory.RabbitMqEventPublisher,
    InventoryOutboxRelay: inventory.OutboxRelay,
    SalesDatabase: sales.SalesDatabase,
    SalesSecretBox: sales.AesGcmSecretBox,
    SalesModuleEventHandlers: sales.SalesModuleEventHandlers,
    PlaceOrderUseCase: sales.PlaceOrderUseCase,
    SalesConsumer: sales.RabbitMqEventConsumer,
    SalesPublisher: sales.RabbitMqEventPublisher,
    SalesOutboxRelay: sales.OutboxRelay,
    WebhookDatabase: webhooks.WebhookDatabase,
    CreateSubscriptionUseCase: webhooks.CreateSubscriptionUseCase,
    WebhookDispatcher: webhooks.WebhookDispatcher,
    FetchWebhookClient: webhooks.FetchWebhookClient,
    WebhookEventConsumer: webhooks.WebhookEventConsumer,
  }
}

async function readFixture(identity, catalog, inventory, sales) {
  const [tenant] = await identity`select tenant_id from tenant_directory where slug = 'horizon-demo'`
  if (!tenant) throw new Error('Run make demo once before starting the load target')
  const [item] = await catalog`select id from catalog_items
    where tenant_id = ${tenant.tenant_id} and sku = 'COFFEE-001'`
  const [warehouse] = await inventory`select id from warehouses
    where tenant_id = ${tenant.tenant_id} and name = 'Golden warehouse'`
  const [customer] = await sales`select id from customers
    where tenant_id = ${tenant.tenant_id} and status = 'active' order by created_at limit 1`
  if (!item || !warehouse || !customer) throw new Error('Golden-path fixture is incomplete')
  await inventory`update stock_balances set on_hand = greatest(on_hand, 1000000000000),
    updated_at = now() where tenant_id = ${tenant.tenant_id} and item_id = ${item.id}
      and warehouse_id = ${warehouse.id}`
  return {
    tenantId: tenant.tenant_id,
    itemId: item.id,
    warehouseId: warehouse.id,
    customerId: customer.id,
  }
}

async function converge(orderId, tenantId, salesRelay, inventoryRelay, sales, inventory) {
  const deadline = Date.now() + 10_000
  for (;;) {
    await pump(salesRelay, inventoryRelay)
    const [[order], [reservation]] = await Promise.all([
      sales`select status from sales_orders where tenant_id = ${tenantId} and id = ${orderId}`,
      inventory`select status from stock_reservations
        where tenant_id = ${tenantId} and order_id = ${orderId}`,
    ])
    if (order?.status === 'confirmed' && reservation?.status === 'confirmed') return
    if (Date.now() >= deadline) throw new Error('Golden-path order did not converge')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function pump(salesRelay, inventoryRelay) {
  pumpInFlight ??= (async () => {
    try {
      await flushAll(salesRelay)
      await flushAll(inventoryRelay)
      await flushAll(salesRelay)
      await flushAll(inventoryRelay)
    } finally {
      pumpInFlight = undefined
    }
  })()
  return pumpInFlight
}

function pumpWebhooks(dispatcher) {
  webhookPumpInFlight ??= (async () => {
    try {
      await dispatcher.flush()
    } finally {
      webhookPumpInFlight = undefined
    }
  })()
  return webhookPumpInFlight
}

async function flushAll(relay) {
  for (;;) if ((await relay.flush()) === 0) return
}

async function startCallbackReceiver() {
  let secret = ''
  const deliveredEventIds = new Set()
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const fields = Object.fromEntries(
        String(request.headers['x-horizon-signature'] ?? '')
          .split(',')
          .map((part) => part.split('=', 2)),
      )
      const expected = createHmac('sha256', secret)
        .update(`${fields.t ?? ''}.${body}`)
        .digest()
      const actual = Buffer.from(fields.v1 ?? '', 'hex')
      const valid = actual.length === expected.length && timingSafeEqual(actual, expected)
      if (valid) deliveredEventIds.add(String(request.headers['x-horizon-event-id'] ?? ''))
      response.writeHead(valid ? 204 : 401).end()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(3940, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Callback receiver did not bind')
  return {
    url: `http://127.0.0.1:${address.port}/events`,
    has: (eventId) => deliveredEventIds.has(eventId),
    setSecret: (value) => {
      secret = value
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function deleteQueues(url, queues) {
  const connection = await connect(url)
  try {
    const channel = await connection.createChannel()
    try {
      for (const queue of queues) await channel.deleteQueue(queue)
    } finally {
      await channel.close()
    }
  } finally {
    await connection.close()
  }
}

async function loadEnv(path) {
  try {
    const contents = await readFile(path, 'utf8')
    return Object.fromEntries(
      contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const separator = line.indexOf('=')
          return [line.slice(0, separator), line.slice(separator + 1)]
        }),
    )
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
}

async function waitFor(read, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null && value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function closeAll() {
  for (const close of resources.reverse()) {
    try {
      await close()
    } catch {
      // Keep shutting down independent resources.
    }
  }
}
