import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common'
import { z } from 'zod'
import { WebhookRuntime } from '@/main/webhook-runtime'
import { RequireWebhookAction, tenantOf, type WebhookRequest } from './authorization'

const subscriptionInput = z.strictObject({
  endpointUrl: z.url(),
  eventTypes: z.array(z.string().min(1).max(160)).min(1).max(50),
})

@Controller('webhook-subscriptions')
export class WebhookSubscriptionsController {
  constructor(@Inject(WebhookRuntime) private readonly runtime: WebhookRuntime) {}

  @Get()
  @RequireWebhookAction('read')
  async list(@Req() request: WebhookRequest) {
    return (await this.runtime.database.listSubscriptions(tenantOf(request))).map((row) => ({
      id: row.id,
      endpointUrl: row.endpointUrl,
      eventTypes: row.eventTypes,
      active: row.active,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
  }

  @Post()
  @RequireWebhookAction('manage')
  create(@Body() body: unknown, @Req() request: WebhookRequest) {
    const input = subscriptionInput.parse(body)
    return this.runtime.createSubscription.execute({ ...input, tenantId: tenantOf(request) })
  }

  @Delete(':id')
  @RequireWebhookAction('manage')
  async deactivate(@Param('id') id: string, @Req() request: WebhookRequest) {
    await this.runtime.deactivateSubscription.execute({
      tenantId: tenantOf(request),
      subscriptionId: z.uuid().parse(id),
    })
  }
}

@Controller('webhook-deliveries')
export class WebhookDeliveriesController {
  constructor(@Inject(WebhookRuntime) private readonly runtime: WebhookRuntime) {}

  @Get()
  @RequireWebhookAction('read')
  async list(@Req() request: WebhookRequest) {
    return (await this.runtime.database.listDeliveries(tenantOf(request))).map((row) => ({
      id: row.id,
      subscriptionId: row.subscriptionId,
      eventId: row.event.eventId,
      eventType: row.event.eventType,
      status: row.status,
      attemptCount: row.attemptCount,
      nextAttemptAt: row.nextAttemptAt,
      lastResponseStatus: row.lastResponseStatus,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
  }

  @Get(':id/attempts')
  @RequireWebhookAction('read')
  attempts(@Param('id') id: string, @Req() request: WebhookRequest) {
    return this.runtime.database.listAttempts(tenantOf(request), z.uuid().parse(id))
  }

  @Post(':id/replay')
  @RequireWebhookAction('manage')
  async replay(@Param('id') id: string, @Req() request: WebhookRequest) {
    await this.runtime.replayDelivery.execute({
      tenantId: tenantOf(request),
      deliveryId: z.uuid().parse(id),
    })
  }
}
