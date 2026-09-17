#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const identityRequire = createRequire(join(root, 'identity/package.json'))
const catalogRequire = createRequire(join(root, 'catalog/package.json'))
const inventoryRequire = createRequire(join(root, 'inventory/package.json'))
const salesRequire = createRequire(join(root, 'sales/package.json'))
const webhooksRequire = createRequire(join(root, 'webhooks/package.json'))
const partiesRequire = createRequire(join(root, 'parties/package.json'))
const financialRequire = createRequire(join(root, 'financial/package.json'))
const postgres = salesRequire('postgres')
const { drizzle } = salesRequire('drizzle-orm/postgres-js')
const { migrate } = salesRequire('drizzle-orm/postgres-js/migrator')
const { connect } = salesRequire('amqplib')
const { trace } = salesRequire('@opentelemetry/api')
const { NodeSDK, tracing } = salesRequire('@opentelemetry/sdk-node')
const { OTLPTraceExporter } = salesRequire('@opentelemetry/exporter-trace-otlp-http')
const { resourceFromAttributes } = salesRequire('@opentelemetry/resources')
const { ATTR_SERVICE_NAME } = salesRequire('@opentelemetry/semantic-conventions')

const DEMO = Object.freeze({
  slug: 'horizon-demo',
  ownerEmail: 'owner@horizon.local',
  operatorEmail: 'demo@horizon.local',
  sku: 'COFFEE-001',
  customerTaxId: '12345678901',
  warehouseName: 'Golden warehouse',
  initialStockMicros: 1_000_000_000_000n,
  quantity: '4',
  unitPrice: '1250',
  revenueCategory: '1.01',
})

const DEMO_CUSTOMER = Object.freeze({
  legalName: 'Horizon Coffee Buyer',
  email: 'buyer@horizon.local',
  phone: '+5511999999999',
  address: 'Avenida Paulista, 1000, Sao Paulo - SP',
})

const resources = []
const env = await loadEnv(join(root, 'infra/.env'))
const port = (name, fallback) => env[name] ?? process.env[name] ?? fallback
const postgresPort = port('HORIZON_POSTGRES_PORT', '5432')
const rabbitPort = port('HORIZON_RABBITMQ_PORT', '5672')
const otlpPort = port('HORIZON_OTLP_HTTP_PORT', '4318')
const jaegerPort = port('HORIZON_JAEGER_PORT', '16686')
const rabbitUrl = `amqp://horizon:horizon@localhost:${rabbitPort}`
const moduleUrls = (name) => ({
  owner: `postgres://horizon_owner:horizon@localhost:${postgresPort}/horizon_${name}`,
  app: `postgres://horizon_app:horizon@localhost:${postgresPort}/horizon_${name}`,
  relay: `postgres://horizon_relay:horizon@localhost:${postgresPort}/horizon_${name}`,
  admin: `postgres://postgres:postgres@localhost:${postgresPort}/horizon_${name}`,
})

let telemetry
const serviceProviders = []

try {
  await migrateModules()

  telemetry = new NodeSDK({
    serviceName: 'sales',
    traceExporter: new OTLPTraceExporter({ url: `http://localhost:${otlpPort}/v1/traces` }),
    logRecordProcessors: [],
    metricReaders: [],
  })
  telemetry.start()
  const inventoryTracer = makeServiceTracer('inventory')
  const webhooksTracer = makeServiceTracer('webhooks')

  const modules = loadModules()
  const clock = { now: () => new Date() }
  const identityUrls = moduleUrls('identity')
  const catalogUrls = moduleUrls('catalog')
  const inventoryUrls = moduleUrls('inventory')
  const salesUrls = moduleUrls('sales')
  const webhooksUrls = moduleUrls('webhooks')
  const partiesUrls = moduleUrls('parties')
  const financialUrls = moduleUrls('financial')
  const blindIndexKey = Buffer.from(
    (await readFile(join(root, 'infra/keys/blind-index.key'), 'utf8')).trim(),
    'hex',
  )

  const identityDb = new modules.IdentityDatabase({
    url: identityUrls.app,
    secretBox: new modules.IdentitySecretBox(),
    blindIndexKey,
  })
  const catalogDb = new modules.CatalogDatabase({ url: catalogUrls.app })
  const inventoryDb = new modules.InventoryDatabase({ url: inventoryUrls.app })
  const salesDb = new modules.SalesDatabase({
    url: salesUrls.app,
    customerPrivacy: {
      secretBox: new modules.SalesSecretBox(),
      blindIndexKey: Buffer.from('0'.repeat(64)),
    },
  })
  const partiesDb = new modules.PartiesDatabase({
    url: partiesUrls.app,
    privacy: {
      secretBox: new modules.PartiesSecretBox(),
      blindIndexKey: Buffer.from('0'.repeat(64), 'hex'),
    },
  })
  const financialDb = new modules.FinancialDatabase({ url: financialUrls.app })
  const webhooksDb = new modules.WebhookDatabase({
    appUrl: webhooksUrls.app,
    workerUrl: webhooksUrls.relay,
    encryptionKey: Buffer.alloc(32),
  })
  const identityAdmin = postgres(identityUrls.admin, { max: 1 })
  const inventoryAdmin = postgres(inventoryUrls.admin, { max: 1 })
  const salesAdmin = postgres(salesUrls.admin, { max: 1 })
  const financialAdmin = postgres(financialUrls.admin, { max: 1 })
  resources.push(() => identityDb.close())
  resources.push(() => catalogDb.close())
  resources.push(() => inventoryDb.close())
  resources.push(() => salesDb.close())
  resources.push(() => webhooksDb.close())
  resources.push(() => partiesDb.close())
  resources.push(() => financialDb.close())
  resources.push(() => financialAdmin.end())
  resources.push(() => identityAdmin.end())
  resources.push(() => inventoryAdmin.end())
  resources.push(() => salesAdmin.end())

  const identity = await seedIdentity(modules, identityDb, identityAdmin, clock)
  const catalog = await seedCatalog(modules, catalogDb, identity, clock)
  await Promise.all([
    inventoryDb.provisionTenant(identity.tenantId),
    salesDb.provisionTenant(identity.tenantId),
    webhooksDb.provisionTenant(identity.tenantId),
  ])
  const warehouseId = await seedInventory(
    inventoryAdmin,
    identity.tenantId,
    catalog.itemId,
  )
  await seedSalesProjection(salesAdmin, identity.tenantId, catalog.itemId)

  const inventoryHandlers = new modules.InventorySalesEventHandlers(inventoryDb, clock, 1800)
  const salesHandlers = new modules.SalesModuleEventHandlers(salesDb, clock)
  const financialHandlers = new modules.FinancialModuleEventHandlers(financialDb, clock)
  const inventoryQueue = 'horizon.demo.inventory'
  const salesQueue = 'horizon.demo.sales'
  const webhooksQueue = 'horizon.demo.webhooks'
  const financialQueue = 'horizon.demo.financial'
  const inventoryConsumer = new modules.InventoryConsumer({
    url: rabbitUrl,
    queue: inventoryQueue,
    handlers: tracedHandlers(inventoryHandlers.handlers, inventoryTracer),
    prefetch: 5,
  })
  const salesConsumer = new modules.SalesConsumer({
    url: rabbitUrl,
    queue: salesQueue,
    handlers: salesHandlers.handlers,
    prefetch: 5,
  })
  const financialConsumer = new modules.FinancialConsumer({
    url: rabbitUrl,
    queue: financialQueue,
    handlers: financialHandlers.handlers,
    prefetch: 5,
  })
  const webhooksConsumer = new modules.WebhookEventConsumer({
    url: rabbitUrl,
    queue: webhooksQueue,
    repository: webhooksDb,
    prefetch: 5,
  })
  await Promise.all([
    inventoryConsumer.start(),
    salesConsumer.start(),
    financialConsumer.start(),
    webhooksConsumer.start(),
  ])
  resources.push(() =>
    deleteQueues(rabbitUrl, [
      inventoryQueue,
      salesQueue,
      financialQueue,
      `${financialQueue}.dlq`,
      webhooksQueue,
      `${webhooksQueue}.dlq`,
    ]),
  )
  resources.push(() => inventoryConsumer.close())
  resources.push(() => salesConsumer.close())
  resources.push(() => financialConsumer.close())
  resources.push(() => webhooksConsumer.close())

  const callback = await startStubReceiver()
  resources.push(callback.close)
  const existingSubscription = (await webhooksDb.listSubscriptions(identity.tenantId)).find(
    (subscription) => subscription.active && subscription.endpointUrl === callback.url,
  )
  const subscription = existingSubscription
    ? { subscriptionId: existingSubscription.id, secret: existingSubscription.secret }
    : await new modules.CreateSubscriptionUseCase(webhooksDb, clock).execute({
        tenantId: identity.tenantId,
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
  const sinkConnection = await connect(rabbitUrl)
  const sink = await sinkConnection.createChannel()
  const sinkQueue = (await sink.assertQueue('', { exclusive: true })).queue
  for (const eventType of [
    'sales.order.confirmed',
    'sales.invoicing.requested',
    'inventory.stock.moved',
    'financial.receivable.posted',
    'financial.settlement.recorded',
  ])
    await sink.bindQueue(sinkQueue, 'horizon.events', eventType)
  const observedEvents = []
  await sink.consume(
    sinkQueue,
    (message) => {
      if (!message) return
      observedEvents.push(JSON.parse(message.content.toString()))
      sink.ack(message)
    },
    { noAck: false },
  )
  resources.push(() => sink.close())
  resources.push(() => sinkConnection.close())

  const catalogPublisher = await modules.CatalogPublisher.open(rabbitUrl)
  const inventoryPublisher = await modules.InventoryPublisher.open(rabbitUrl)
  const salesPublisher = await modules.SalesPublisher.open(rabbitUrl)
  const catalogRelay = new modules.CatalogOutboxRelay(catalogUrls.relay, catalogPublisher)
  const inventoryRelay = new modules.InventoryOutboxRelay(
    inventoryUrls.relay,
    inventoryPublisher,
  )
  const salesRelay = new modules.SalesOutboxRelay(salesUrls.relay, salesPublisher)
  const partiesRelay = new modules.PartiesOutboxRelay(partiesUrls.relay, salesPublisher)
  const financialRelay = new modules.FinancialOutboxRelay(financialUrls.relay, salesPublisher)
  resources.push(() => partiesRelay.close())
  resources.push(() => financialRelay.close())
  resources.push(() => catalogRelay.close())
  resources.push(() => inventoryRelay.close())
  resources.push(() => salesRelay.close())
  resources.push(() => catalogPublisher.close())
  resources.push(() => inventoryPublisher.close())
  resources.push(() => salesPublisher.close())

  // Flush seed events as well. Sales is reconciled above so the demo remains recoverable
  // if only one module database was reset between runs.
  await flushAll(catalogRelay)

  // The customer is a party (ADR 0040): registered in the registry, published, and
  // projected by Sales through the same consumer the service runs.
  const customerId = await seedCustomer(modules, partiesDb, salesAdmin, identity.tenantId, clock)
  await flushUntil(
    partiesRelay,
    () =>
      rowOrNull(salesAdmin`select id from customers
        where tenant_id = ${identity.tenantId} and id = ${customerId} and status = 'active'`),
    'the Sales projection of the demo customer',
  )
  await flushUntil(
    partiesRelay,
    () =>
      rowOrNull(financialAdmin`select party_id from party_projection
        where tenant_id = ${identity.tenantId} and party_id = ${customerId}`),
    'the Financial projection of the demo customer',
  )

  const [before] = await inventoryAdmin`select on_hand from stock_balances
    where tenant_id = ${identity.tenantId} and item_id = ${catalog.itemId}
      and warehouse_id = ${warehouseId}`
  const stockBefore = BigInt(before.on_hand)
  let orderId = ''
  let receivable = { titleId: '', status: '', outstanding: '' }
  let traceId = ''
  await trace.getTracer('horizon.demo').startActiveSpan('golden-path', async (span) => {
    traceId = span.spanContext().traceId
    try {
      const placed = await new modules.PlaceOrderUseCase(salesDb, clock).execute({
        tenantId: identity.tenantId,
        customerId,
        fulfillmentWarehouseId: warehouseId,
        lines: [{ lineId: randomUUID(), itemId: catalog.itemId, quantity: DEMO.quantity }],
      })
      if (placed.isLeft()) throw placed.value
      orderId = placed.value.orderId

      await flushUntil(salesRelay, async () =>
        rowOrNull(inventoryAdmin`select id from stock_reservations
          where tenant_id = ${identity.tenantId} and order_id = ${orderId}`),
      )
      await flushUntil(inventoryRelay, async () =>
        rowOrNull(salesAdmin`select status from sales_orders
          where tenant_id = ${identity.tenantId} and id = ${orderId} and status = 'confirmed'`),
      )
      await flushUntil(salesRelay, async () =>
        rowOrNull(inventoryAdmin`select status from stock_reservations
          where tenant_id = ${identity.tenantId} and order_id = ${orderId}
            and status = 'confirmed'`),
      )
      await flushAll(inventoryRelay)

      receivable = await collectReceivable(modules, {
        database: financialDb,
        admin: financialAdmin,
        relay: financialRelay,
        tenantId: identity.tenantId,
        orderId,
        clock,
      })
      await waitFor(
        () =>
          observedEvents.find(
            (event) =>
              event.eventType === 'financial.settlement.recorded' &&
              event.payload.titleId === receivable.titleId,
          ) ?? null,
        'published financial.settlement.recorded event',
      )

      const confirmedEvent = await waitFor(
        () =>
          observedEvents.find(
            (event) =>
              event.eventType === 'sales.order.confirmed' && event.payload.orderId === orderId,
          ) ?? null,
        'published sales.order.confirmed event',
      )
      await waitFor(async () => {
        const deliveries = await webhooksDb.listDeliveries(identity.tenantId)
        return deliveries.find((item) => item.event.eventId === confirmedEvent.eventId) ?? null
      }, 'webhooks consumer to schedule the confirmed-order delivery')
      await webhooksTracer.startActiveSpan('webhook.deliver', async (deliverySpan) => {
        try {
          await waitFor(
            async () => {
              await webhookDispatcher.flush()
              return (
                callback.deliveries.find((item) => item.eventId === confirmedEvent.eventId) ?? null
              )
            },
            'signed callback from the Webhooks worker',
          )
        } finally {
          deliverySpan.end()
        }
      })
    } finally {
      span.end()
    }
  })

  const [balance] = await inventoryAdmin`select on_hand, reserved from stock_balances
    where tenant_id = ${identity.tenantId} and item_id = ${catalog.itemId}
      and warehouse_id = ${warehouseId}`
  const [order] = await salesAdmin`select status, total, currency from sales_orders
    where tenant_id = ${identity.tenantId} and id = ${orderId}`
  assert.equal(order.status, 'confirmed')
  assert.equal(order.total, '5000')
  assert.equal(order.currency, 'BRL')
  assert.equal(BigInt(balance.on_hand), stockBefore - 4_000_000n)
  assert.equal(balance.reserved, '0')
  assert.equal(receivable.status, 'posted')
  assert.equal(receivable.settlementState, 'settled')
  assert.equal(receivable.outstanding, '0')

  await closeAll()
  await shutdownServiceProviders()
  await telemetry.shutdown()
  telemetry = undefined
  const traceUrl = `http://localhost:${jaegerPort}/trace/${traceId}`
  const traceServices = await waitForJaeger(jaegerPort, traceId)
  for (const service of ['sales', 'inventory', 'webhooks'])
    assert(traceServices.includes(service), `Trace is missing the ${service} service`)

  console.log(
    JSON.stringify(
      {
        ok: true,
        seeded: {
          tenantId: identity.tenantId,
          ownerId: identity.ownerId,
          operatorId: identity.operatorId,
          itemId: catalog.itemId,
          warehouseId,
          customerId,
        },
        order: { orderId, status: order.status, total: order.total, currency: order.currency },
        stock: { before: stockBefore.toString(), after: balance.on_hand, reserved: balance.reserved },
        receivable,
        callback: {
          signed: true,
          implementation: 'webhooks',
          subscriptionId: subscription.subscriptionId,
          deliveries: callback.deliveries.length,
        },
        trace: { traceId, services: traceServices, storedInJaeger: true, url: traceUrl },
      },
      null,
      2,
    ),
  )
} finally {
  await closeAll()
  await shutdownServiceProviders()
  await telemetry?.shutdown().catch(() => undefined)
}

function makeServiceTracer(serviceName) {
  const provider = new tracing.BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [
      new tracing.SimpleSpanProcessor(
        new OTLPTraceExporter({ url: `http://localhost:${otlpPort}/v1/traces` }),
      ),
    ],
  })
  serviceProviders.push(provider)
  return provider.getTracer(`horizon.${serviceName}`)
}

function tracedHandlers(handlers, tracer) {
  return Object.fromEntries(
    Object.entries(handlers).map(([eventType, handler]) => [
      eventType,
      (event) =>
        tracer.startActiveSpan(`${eventType}.handle`, async (span) => {
          try {
            await handler(event)
          } finally {
            span.end()
          }
        }),
    ]),
  )
}

async function shutdownServiceProviders() {
  await Promise.allSettled(serviceProviders.splice(0).map((provider) => provider.shutdown()))
}

function loadModules() {
  const from = (require, path) => require(join(root, path))
  const identity = {
    ...from(identityRequire, 'identity/dist/infrastructure/database/drizzle/identity-database.js'),
    ...from(identityRequire, 'identity/dist/infrastructure/cryptography/aes-gcm-secret-box.js'),
    ...from(identityRequire, 'identity/dist/infrastructure/cryptography/argon2-password-hasher.js'),
    ...from(identityRequire, 'identity/dist/infrastructure/cryptography/crypto-secret-generator.js'),
    ...from(identityRequire, 'identity/dist/application/use-cases/create-tenant.js'),
    ...from(identityRequire, 'identity/dist/application/use-cases/register-user.js'),
    ...from(identityRequire, 'identity/dist/domain/value-objects/email.js'),
  }
  const catalog = {
    ...from(catalogRequire, 'catalog/dist/infrastructure/database/drizzle/catalog-database.js'),
    ...from(catalogRequire, 'catalog/dist/application/use-cases/provision-tenant-catalog.js'),
    ...from(catalogRequire, 'catalog/dist/application/use-cases/create-catalog-item.js'),
    ...from(catalogRequire, 'catalog/dist/application/use-cases/manage-prices.js'),
  }
  const { RabbitMqEventPublisher: CatalogPublisher } = from(
    catalogRequire,
    'catalog/dist/infrastructure/messaging/rabbitmq-event-publisher.js',
  )
  const { OutboxRelay: CatalogOutboxRelay } = from(
    catalogRequire,
    'catalog/dist/infrastructure/messaging/outbox-relay.js',
  )
  const inventory = {
    ...from(inventoryRequire, 'inventory/dist/infrastructure/database/drizzle/inventory-database.js'),
    ...from(inventoryRequire, 'inventory/dist/application/consume-sales-events.js'),
  }
  const inventoryTransport = from(
    inventoryRequire,
    'inventory/dist/infrastructure/messaging/rabbitmq-transport.js',
  )
  const sales = {
    ...from(salesRequire, 'sales/dist/infrastructure/database/drizzle/sales-database.js'),
    ...from(salesRequire, 'sales/dist/infrastructure/cryptography/aes-gcm-secret-box.js'),
    ...from(salesRequire, 'sales/dist/application/consume-module-events.js'),
    ...from(salesRequire, 'sales/dist/application/use-cases/place-order.js'),
  }
  const salesTransport = from(
    salesRequire,
    'sales/dist/infrastructure/messaging/rabbitmq-transport.js',
  )
  const parties = {
    ...from(partiesRequire, 'parties/dist/infrastructure/database/drizzle/parties-database.js'),
    ...from(partiesRequire, 'parties/dist/infrastructure/cryptography/aes-gcm-secret-box.js'),
    ...from(partiesRequire, 'parties/dist/application/use-cases/manage-parties.js'),
  }
  const partiesTransport = from(
    partiesRequire,
    'parties/dist/infrastructure/messaging/rabbitmq-transport.js',
  )
  const financial = {
    ...from(financialRequire, 'financial/dist/infrastructure/database/drizzle/financial-database.js'),
    ...from(financialRequire, 'financial/dist/application/consume-module-events.js'),
    ...from(financialRequire, 'financial/dist/application/use-cases/manage-dimensions.js'),
    ...from(financialRequire, 'financial/dist/application/use-cases/manage-titles.js'),
  }
  const financialTransport = from(
    financialRequire,
    'financial/dist/infrastructure/messaging/rabbitmq-transport.js',
  )
  const webhooks = {
    ...from(webhooksRequire, 'webhooks/dist/infrastructure/database/webhook-database.js'),
    ...from(webhooksRequire, 'webhooks/dist/application/webhook-service.js'),
    ...from(webhooksRequire, 'webhooks/dist/infrastructure/http/fetch-webhook-client.js'),
    ...from(webhooksRequire, 'webhooks/dist/infrastructure/messaging/event-consumer.js'),
  }
  return {
    IdentityDatabase: identity.IdentityDatabase,
    IdentitySecretBox: identity.AesGcmSecretBox,
    Argon2PasswordHasher: identity.Argon2PasswordHasher,
    CryptoSecretGenerator: identity.CryptoSecretGenerator,
    CreateTenantUseCase: identity.CreateTenantUseCase,
    RegisterUserUseCase: identity.RegisterUserUseCase,
    Email: identity.Email,
    CatalogDatabase: catalog.CatalogDatabase,
    ProvisionTenantCatalogUseCase: catalog.ProvisionTenantCatalogUseCase,
    CreateCatalogItemUseCase: catalog.CreateCatalogItemUseCase,
    SetPriceUseCase: catalog.SetPriceUseCase,
    CatalogPublisher,
    CatalogOutboxRelay,
    InventoryDatabase: inventory.InventoryDatabase,
    InventorySalesEventHandlers: inventory.InventorySalesEventHandlers,
    InventoryConsumer: inventoryTransport.RabbitMqEventConsumer,
    InventoryPublisher: inventoryTransport.RabbitMqEventPublisher,
    InventoryOutboxRelay: inventoryTransport.OutboxRelay,
    SalesDatabase: sales.SalesDatabase,
    SalesSecretBox: sales.AesGcmSecretBox,
    SalesModuleEventHandlers: sales.SalesModuleEventHandlers,
    PartiesDatabase: parties.PartiesDatabase,
    PartiesSecretBox: parties.AesGcmSecretBox,
    RegisterPartyUseCase: parties.RegisterPartyUseCase,
    DescribePartyUseCase: parties.DescribePartyUseCase,
    PartiesOutboxRelay: partiesTransport.OutboxRelay,
    PlaceOrderUseCase: sales.PlaceOrderUseCase,
    SalesConsumer: salesTransport.RabbitMqEventConsumer,
    SalesPublisher: salesTransport.RabbitMqEventPublisher,
    SalesOutboxRelay: salesTransport.OutboxRelay,
    FinancialDatabase: financial.FinancialDatabase,
    FinancialModuleEventHandlers: financial.FinancialModuleEventHandlers,
    FinancialConsumer: financialTransport.RabbitMqEventConsumer,
    FinancialOutboxRelay: financialTransport.OutboxRelay,
    DefineCategoryUseCase: financial.DefineCategoryUseCase,
    ReviseTitleUseCase: financial.ReviseTitleUseCase,
    PostTitleUseCase: financial.PostTitleUseCase,
    RecordSettlementUseCase: financial.RecordSettlementUseCase,
    WebhookDatabase: webhooks.WebhookDatabase,
    CreateSubscriptionUseCase: webhooks.CreateSubscriptionUseCase,
    WebhookDispatcher: webhooks.WebhookDispatcher,
    FetchWebhookClient: webhooks.FetchWebhookClient,
    WebhookEventConsumer: webhooks.WebhookEventConsumer,
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

async function migrateModules() {
  for (const name of ['identity', 'catalog', 'inventory', 'sales', 'parties', 'financial']) {
    const client = postgres(moduleUrls(name).owner, { max: 1, connect_timeout: 5 })
    try {
      await migrate(drizzle(client), {
        migrationsFolder: join(root, name, 'src/infrastructure/database/drizzle/migrations'),
      })
    } finally {
      await client.end({ timeout: 5 })
    }
  }
  const client = postgres(moduleUrls('webhooks').owner, { max: 1, connect_timeout: 5 })
  try {
    const name = '0000_webhooks.sql'
    await client`create schema if not exists horizon_migrations`
    await client`create table if not exists horizon_migrations.applied (
      name text primary key, applied_at timestamptz not null default now()
    )`
    const [applied] = await client`select 1 from horizon_migrations.applied where name = ${name}`
    if (!applied) {
      const sql = await readFile(
        join(root, 'webhooks/src/infrastructure/database/migrations', name),
        'utf8',
      )
      await client.begin(async (transaction) => {
        await transaction.unsafe(sql)
        await transaction`insert into horizon_migrations.applied (name) values (${name})`
      })
    }
  } finally {
    await client.end({ timeout: 5 })
  }
}

async function seedIdentity(modules, database, admin, clock) {
  let tenantId = await database.directory.resolve(DEMO.slug)
  let ownerId
  const hasher = new modules.Argon2PasswordHasher()
  const secrets = new modules.CryptoSecretGenerator()
  if (!tenantId) {
    const created = await new modules.CreateTenantUseCase(
      database,
      database.directory,
      hasher,
      secrets,
      clock,
    ).execute({
      name: 'Horizon Demo',
      slug: DEMO.slug,
      timezone: 'America/Sao_Paulo',
      owner: { email: DEMO.ownerEmail, name: 'Demo Owner', password: 'Horizon-demo-2026!' },
    })
    if (created.isLeft()) throw created.value
    tenantId = created.value.tenantId
    ownerId = created.value.ownerId
  } else {
    const [owner] = await admin`select id from users where tenant_id = ${tenantId}
      order by created_at asc limit 1`
    if (!owner) throw new Error('Demo tenant exists without an owner')
    ownerId = owner.id
  }

  const email = modules.Email.create(DEMO.operatorEmail)
  if (email.isLeft()) throw email.value
  let operator = await database.inTenant(tenantId, (scope) => scope.users.findByEmail(email.value))
  if (!operator) {
    const registered = await new modules.RegisterUserUseCase(database, hasher, secrets, clock).execute({
      tenantId,
      email: DEMO.operatorEmail,
      name: 'Demo Operator',
      password: 'Horizon-demo-2026!',
      roles: [
        { module: 'identity', role: 'owner' },
        { module: 'catalog', role: 'admin' },
        { module: 'inventory', role: 'admin' },
        { module: 'sales', role: 'admin' },
        { module: 'webhooks', role: 'admin' },
        { module: 'parties', role: 'admin' },
        { module: 'financial', role: 'admin' },
      ],
      actor: { type: 'user', id: ownerId },
    })
    if (registered.isLeft()) throw registered.value
    return { tenantId, ownerId, operatorId: registered.value.userId }
  }
  for (const assignment of [
    { module: 'identity', role: 'owner' },
    { module: 'parties', role: 'admin' },
    { module: 'financial', role: 'admin' },
  ]) {
    if (operator.holds(assignment)) continue
    const granted = operator.grant(assignment, clock.now())
    if (granted.isLeft()) throw granted.value
    await database.inTenant(tenantId, (scope) => scope.users.save(operator))
  }
  return { tenantId, ownerId, operatorId: operator.id.toString() }
}

async function seedCatalog(modules, database, identity, clock) {
  const provisioned = await new modules.ProvisionTenantCatalogUseCase(database, clock, {
    priceListCurrency: 'BRL',
  }).execute({
    tenantId: identity.tenantId,
    event: {
      sourceModule: 'identity',
      eventId: '00000000-0000-4000-8000-000000000008',
      eventType: 'identity.tenant.created',
    },
  })
  if (provisioned.isLeft()) throw provisioned.value
  const actor = { type: 'user', id: identity.operatorId }
  const state = await database.inTenant(identity.tenantId, async (scope) => ({
    unit: await scope.units.findByCode('UN'),
    item: await scope.items.findBySku(DEMO.sku),
    priceList: await scope.priceLists.findByName('Base'),
  }))
  if (!state.unit || !state.priceList) throw new Error('Catalog defaults were not provisioned')
  let itemId = state.item?.id.toString()
  if (!itemId) {
    const created = await new modules.CreateCatalogItemUseCase(database, clock).execute({
      tenantId: identity.tenantId,
      kind: 'product',
      sku: DEMO.sku,
      name: 'Roasted coffee',
      unitId: state.unit.id.toString(),
      ncm: '09012100',
      actor,
    })
    if (created.isLeft()) throw created.value
    itemId = created.value.itemId
  }
  const priced = await new modules.SetPriceUseCase(database, clock).execute({
    tenantId: identity.tenantId,
    priceListId: state.priceList.id.toString(),
    itemId,
    amount: DEMO.unitPrice,
    currency: 'BRL',
    actor,
  })
  if (priced.isLeft()) throw priced.value
  return { itemId, priceListId: state.priceList.id.toString() }
}

async function seedInventory(admin, tenantId, itemId) {
  const [existing] = await admin`select id from warehouses
    where tenant_id = ${tenantId} and name = ${DEMO.warehouseName}`
  const warehouseId = existing?.id ?? randomUUID()
  await admin`insert into warehouses (id, tenant_id, name, created_at, updated_at)
    values (${warehouseId}, ${tenantId}, ${DEMO.warehouseName}, now(), now())
    on conflict (tenant_id, name) do update set active = 1, updated_at = now()`
  await admin`insert into stock_balances
    (id, tenant_id, item_id, warehouse_id, on_hand, reserved, average_unit_cost, currency, version, updated_at)
    values (${randomUUID()}, ${tenantId}, ${itemId}, ${warehouseId}, ${DEMO.initialStockMicros}, 0,
      ${DEMO.unitPrice}, 'BRL', 0, now())
    on conflict (tenant_id, item_id, warehouse_id) do update set
      on_hand = greatest(stock_balances.on_hand, ${DEMO.initialStockMicros}),
      average_unit_cost = excluded.average_unit_cost,
      currency = excluded.currency,
      updated_at = now()`
  return warehouseId
}

async function seedSalesProjection(admin, tenantId, itemId) {
  await admin`insert into catalog_items
    (tenant_id, item_id, description, unit_price, currency, active, updated_at)
    values (${tenantId}, ${itemId}, 'Roasted coffee', ${DEMO.unitPrice}, 'BRL', 1, now())
    on conflict (tenant_id, item_id) do update set description = excluded.description,
      unit_price = excluded.unit_price, currency = excluded.currency, active = 1,
      updated_at = now()`
}

async function seedCustomer(modules, parties, salesAdmin, tenantId, clock) {
  const existing = await parties.inTenant(tenantId, (scope) =>
    scope.parties.findByTaxId(DEMO.customerTaxId),
  )
  if (existing) {
    // Describing the party again republishes it, so a context that started consuming the
    // registry after the customer was registered (Financial) projects it too.
    const partyId = existing.id.toString()
    const described = await new modules.DescribePartyUseCase(parties, clock).execute({
      tenantId,
      partyId,
      ...DEMO_CUSTOMER,
    })
    if (described.isLeft()) throw described.value
    return partyId
  }
  // A customer Sales registered before the registry existed keeps its identifier.
  const legacyIndex = createHmac('sha256', Buffer.from('0'.repeat(64), 'hex'))
    .update(`${tenantId}:${DEMO.customerTaxId}`)
    .digest('hex')
  const legacy = await rowOrNull(salesAdmin`select id from customers
    where tenant_id = ${tenantId} and tax_id_index = ${legacyIndex}`)
  const registered = await new modules.RegisterPartyUseCase(parties, clock).execute({
    tenantId,
    ...(legacy ? { partyId: legacy.id } : {}),
    kind: 'person',
    taxId: DEMO.customerTaxId,
    ...DEMO_CUSTOMER,
    roles: ['customer'],
  })
  if (registered.isLeft()) throw registered.value
  return registered.value.partyId
}

/**
 * The confirmed order became a draft receivable in Financial. A person would classify it,
 * post it and record the customer's payment; the demo does the same through the use cases
 * the HTTP API runs, with idempotency keys derived from the order so a rerun is harmless.
 */
async function collectReceivable(modules, { database, admin, relay, tenantId, orderId, clock }) {
  const draft = await waitFor(
    () =>
      rowOrNull(admin`select id from titles
        where tenant_id = ${tenantId} and origin_order_id = ${orderId}`),
    'the draft receivable raised from the confirmed order',
  )
  const categories = await database.listCategories(tenantId)
  let categoryId = categories.find((category) => category.code === DEMO.revenueCategory)?.id
  if (!categoryId) {
    const defined = await new modules.DefineCategoryUseCase(database, clock).execute({
      tenantId,
      code: DEMO.revenueCategory,
      name: 'Product sales',
      nature: 'revenue',
    })
    if (defined.isLeft()) throw defined.value
    categoryId = defined.value.id
  }
  const today = new Date().toISOString().slice(0, 10)
  const context = (step) => ({
    tenantId,
    actor: 'system:demo',
    requestId: null,
    idempotencyKey: `demo-${step}-${orderId}`,
  })
  const title = await database.titleDetail(tenantId, 'receivable', draft.id, today)
  if (title.status === 'draft') {
    const revised = await new modules.ReviseTitleUseCase(database, clock, 'receivable').execute({
      context: context('revise'),
      titleId: draft.id,
      terms: {
        partyId: title.partyId,
        documentNumber: title.documentNumber,
        currency: title.currency,
        categoryId,
        issuedOn: title.issuedOn,
        installments: title.installments.map(({ dueOn, amount }) => ({ dueOn, amount })),
      },
    })
    if (revised.isLeft()) throw revised.value
  }
  const posted = await new modules.PostTitleUseCase(database, clock, 'receivable').execute({
    context: context('post'),
    titleId: draft.id,
  })
  if (posted.isLeft()) throw posted.value
  const settled = await new modules.RecordSettlementUseCase(database, clock, 'receivable').execute({
    context: context('settle'),
    titleId: draft.id,
    settlement: {
      installmentNumber: 1,
      settledOn: title.issuedOn > today ? title.issuedOn : today,
      received: title.total,
    },
  })
  if (settled.isLeft()) throw settled.value
  await flushAll(relay)
  const detail = await database.titleDetail(tenantId, 'receivable', draft.id, today)
  return {
    titleId: draft.id,
    status: detail.status,
    settlementState: detail.settlementState,
    total: detail.total,
    outstanding: detail.outstanding,
  }
}

async function flushAll(relay) {
  let total = 0
  for (;;) {
    const count = await relay.flush()
    total += count
    if (count === 0) return total
  }
}

async function flushUntil(relay, read, description = 'next golden-path state') {
  const deadline = Date.now() + 15_000
  for (;;) {
    await flushAll(relay)
    const value = await read()
    if (value !== null) return value
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function rowOrNull(query) {
  const [row] = await query
  return row ?? null
}

async function waitFor(read, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null && value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function startStubReceiver() {
  let secret = ''
  const deliveries = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const signature = request.headers['x-horizon-signature'] ?? ''
      const eventId = request.headers['x-horizon-event-id'] ?? ''
      const valid = verifySignature(secret, body, signature)
      if (valid) deliveries.push({ eventId, receivedAt: new Date().toISOString() })
      response.writeHead(valid ? 204 : 401).end()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(3940, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Stub receiver has no TCP address')
  return {
    deliveries,
    url: `http://127.0.0.1:${address.port}/events`,
    setSecret: (value) => {
      secret = value
    },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

function verifySignature(secret, body, header) {
  const fields = Object.fromEntries(
    String(header)
      .split(',')
      .map((part) => part.split('=', 2)),
  )
  if (!fields.t || !fields.v1) return false
  const expected = createHmac('sha256', secret).update(`${fields.t}.${body}`).digest()
  const actual = Buffer.from(fields.v1, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function waitForJaeger(jaegerPort, traceId) {
  const url = `http://localhost:${jaegerPort}/api/traces/${traceId}`
  try {
    return await waitFor(async () => {
      const response = await fetch(url)
      if (!response.ok) return null
      const payload = await response.json()
      if (!Array.isArray(payload.data) || payload.data.length === 0) return null
      const services = [
        ...new Set(
          payload.data.flatMap((item) =>
            Object.values(item.processes ?? {}).map((process) => process.serviceName),
          ),
        ),
      ]
      return ['sales', 'inventory', 'webhooks'].every((service) => services.includes(service))
        ? services.sort()
        : null
    }, 'trace export to Jaeger', 10_000)
  } catch {
    return []
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

async function closeAll() {
  for (const close of resources.splice(0).reverse()) {
    try {
      await close()
    } catch {
      // Cleanup is best effort and must not hide the primary demo failure.
    }
  }
}
