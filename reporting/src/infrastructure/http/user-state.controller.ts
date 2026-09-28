import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { z } from 'zod'
import type { ReadNotification } from '@/application/notifications'
import type { Reader } from '@/domain/notifications'
import type { SavedView } from '@/domain/views'
import { ReportingRuntime } from '@/main/reporting-runtime'
import { type ReportingRequest, tenantOf } from './authorization'
import { id, parse, unwrap } from './request-parsing'

const viewBody = z
  .object({
    screen: z.string().min(3).max(80),
    name: z.string().min(1).max(80),
    query: z.string().max(1000).default(''),
    columns: z.array(z.string().max(40)).max(30).nullable().default(null),
    shared: z.boolean().default(false),
  })
  .strict()
const viewChanges = z
  .object({
    name: z.string().min(1).max(80).optional(),
    query: z.string().max(1000).optional(),
    columns: z.array(z.string().max(40)).max(30).nullable().optional(),
    shared: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'send at least one change')

function readerOf(request: ReportingRequest): Reader {
  if (!request.principal) throw new UnauthorizedException()
  return { userId: request.principal.subject, roles: request.principal.roles }
}

function presentNotification(notification: ReadNotification) {
  return {
    id: notification.id,
    kind: notification.kind,
    params: notification.params,
    link: notification.link,
    occurredAt: notification.occurredAt,
    createdAt: notification.createdAt,
    read: notification.readAt !== null,
  }
}

function presentView(view: SavedView, userId: string) {
  const { viewId, ownerId, ...rest } = view
  return { id: viewId, ...rest, mine: ownerId === userId }
}

/**
 * The signed-in person's own state (Phase 66): their notifications and saved views. A token
 * is enough; no Reporting role is needed, because neither holds a figure of any module.
 */
@Controller()
export class UserStateController {
  constructor(@Inject(ReportingRuntime) private readonly runtime: ReportingRuntime) {}

  @Get('notifications')
  @Header('Cache-Control', 'no-store')
  async notifications(@Query() query: unknown, @Req() request: ReportingRequest) {
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
      query,
    )
    const found = await this.runtime.notifications.list(tenantOf(request), readerOf(request), limit)
    return { data: found.map(presentNotification) }
  }

  @Get('notifications/unread-count')
  @Header('Cache-Control', 'no-store')
  async unread(@Req() request: ReportingRequest) {
    return { unread: await this.runtime.notifications.unread(tenantOf(request), readerOf(request)) }
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  async readAll(@Req() request: ReportingRequest) {
    return {
      marked: await this.runtime.notifications.markAllRead(tenantOf(request), readerOf(request)),
    }
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  async read(@Param('id') notificationId: string, @Req() request: ReportingRequest) {
    return {
      marked: await this.runtime.notifications.markRead(
        tenantOf(request),
        readerOf(request),
        id(notificationId),
      ),
    }
  }

  @Get('views')
  async views(@Query() query: unknown, @Req() request: ReportingRequest) {
    const { screen } = parse(z.object({ screen: z.string().max(80).optional() }), query)
    const reader = readerOf(request)
    const found = await this.runtime.views.list(tenantOf(request), reader.userId, screen ?? null)
    return { data: found.map((view) => presentView(view, reader.userId)) }
  }

  @Post('views')
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() request: ReportingRequest) {
    const reader = readerOf(request)
    const view = unwrap(
      await this.runtime.views.create(tenantOf(request), reader.userId, parse(viewBody, body)),
    )
    return presentView(view, reader.userId)
  }

  @Patch('views/:id')
  async update(
    @Param('id') viewId: string,
    @Body() body: unknown,
    @Req() request: ReportingRequest,
  ) {
    const reader = readerOf(request)
    const changes = parse(viewChanges, body)
    const view = unwrap(
      await this.runtime.views.update(tenantOf(request), reader.userId, id(viewId), {
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.query === undefined ? {} : { query: changes.query }),
        ...(changes.columns === undefined ? {} : { columns: changes.columns }),
        ...(changes.shared === undefined ? {} : { shared: changes.shared }),
      }),
    )
    return presentView(view, reader.userId)
  }

  @Delete('views/:id')
  async remove(@Param('id') viewId: string, @Req() request: ReportingRequest) {
    return unwrap(
      await this.runtime.views.remove(tenantOf(request), readerOf(request).userId, id(viewId)),
    )
  }
}
