import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import { EndpointRefusedError } from '@/domain/endpoint'
import { WebhookRuntime } from '@/main/webhook-runtime'
import { RequireWebhookAction, tenantOf, type WebhookRequest } from './authorization'

const subscriptionInput = z.strictObject({
  endpointUrl: z.url(),
  eventTypes: z.array(z.string().min(1).max(160)).min(1).max(50),
})

/** A body that does not match is the caller's error (400), never the server's (Phase 79). */
function bodyOf<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success)
    throw new BadRequestException(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
        .join('; ')
        .slice(0, 300),
    )
  return parsed.data
}

/** A path id that is not a UUID names nothing: 404. */
function idOf(id: string): string {
  const parsed = z.uuid().safeParse(id)
  if (!parsed.success) throw new NotFoundException()
  return parsed.data
}

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
  async create(@Body() body: unknown, @Req() request: WebhookRequest) {
    const input = bodyOf(subscriptionInput, body)
    try {
      return await this.runtime.createSubscription.execute({
        ...input,
        tenantId: tenantOf(request),
      })
    } catch (error) {
      // An endpoint outside the public internet is the caller's to fix (Phase 90).
      if (error instanceof EndpointRefusedError) throw new BadRequestException(error.message)
      throw error
    }
  }

  @Delete(':id')
  @RequireWebhookAction('manage')
  async deactivate(@Param('id') id: string, @Req() request: WebhookRequest) {
    await this.runtime.deactivateSubscription.execute({
      tenantId: tenantOf(request),
      subscriptionId: idOf(id),
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
    return this.runtime.database.listAttempts(tenantOf(request), idOf(id))
  }

  @Post(':id/replay')
  @RequireWebhookAction('manage')
  async replay(@Param('id') id: string, @Req() request: WebhookRequest) {
    await this.runtime.replayDelivery.execute({
      tenantId: tenantOf(request),
      deliveryId: idOf(id),
    })
  }
}
