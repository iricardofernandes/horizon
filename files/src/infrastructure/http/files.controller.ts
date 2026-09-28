import {
  ATTACHING_MODULES,
  type AttachingModule,
  attachmentRequestSchema,
} from '@horizon/contracts'
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UnsupportedMediaTypeException,
} from '@nestjs/common'
import { z } from 'zod'
import type { Attachment } from '@/domain/attachment'
import { asciiFileName, encodedFileName } from '@/domain/content'
import { isAttachable, permits, recordTypes } from '@/domain/records'
import { FilesRuntime } from '@/main/files-runtime'
import { type FilesRequest, PublicRoute, principalOf, requireRole } from './authorization'
import { commandContext, idempotentContext } from './command-context'
import { id, parse, unwrap } from './request-parsing'
import { viewOf } from './views'

const recordQuery = z
  .object({
    module: z.enum(ATTACHING_MODULES as [AttachingModule, ...AttachingModule[]]),
    recordType: z.string().min(1).max(40),
    recordId: z.uuid(),
  })
  .refine((query) => isAttachable(query.module, query.recordType), {
    message: 'this module does not take attachments on that record type',
  })

const linkQuery = z.object({
  tenant: z.uuid(),
  expires: z.coerce.number().int(),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
})

/** The one thing the content route needs from the HTTP response. */
interface HeaderSink {
  setHeader(name: string, value: string): unknown
}

function mediaTypeOf(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header
  return (value ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

/**
 * Attachments on the records of other modules (ADR 0060, Phase 65). Slots, lists and links
 * need the owning module's role; the upload and download routes need only their signature.
 */
@Controller()
export class FilesController {
  constructor(@Inject(FilesRuntime) private readonly runtime: FilesRuntime) {}

  @Get('health/live')
  @PublicRoute()
  live() {
    return { status: 'ok' }
  }

  @Get('health/ready')
  @PublicRoute()
  async ready() {
    await this.runtime.database.ping()
    return { status: 'ok' }
  }

  /** The records that take attachments, their retention, and what the caller may do. */
  @Get('record-types')
  recordTypes(@Req() request: FilesRequest) {
    const { roles } = principalOf(request)
    return {
      data: recordTypes().map((type) => ({
        ...type,
        canRead: permits(roles, type.module, 'read'),
        canWrite: permits(roles, type.module, 'write'),
      })),
    }
  }

  @Post('attachments')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async request(@Body() body: unknown, @Req() request: FilesRequest) {
    const input = parse(attachmentRequestSchema, body)
    requireRole(request, input.module, 'write')
    const context = idempotentContext(request)
    const attachment = unwrap(await this.runtime.attachments.request(context, input))
    return {
      attachment: viewOf(attachment),
      upload:
        attachment.status === 'uploading'
          ? this.runtime.links.sign('upload', context.tenantId, attachment.id, new Date())
          : null,
    }
  }

  @Get('attachments')
  async list(@Query() query: unknown, @Req() request: FilesRequest) {
    const record = parse(recordQuery, query)
    requireRole(request, record.module, 'read')
    const found = await this.runtime.attachments.list(principalOf(request).tenantId, record)
    return { data: found.map(viewOf) }
  }

  @Get('attachments/:id')
  async one(@Param('id') attachmentId: string, @Req() request: FilesRequest) {
    return viewOf(await this.readable(request, id(attachmentId)))
  }

  /** A download link valid for five minutes, for an available file. */
  @Get('attachments/:id/link')
  @Header('Cache-Control', 'no-store')
  async link(@Param('id') attachmentId: string, @Req() request: FilesRequest) {
    await this.readable(request, id(attachmentId))
    const context = commandContext(request)
    const attachment = unwrap(await this.runtime.attachments.issueLink(context, id(attachmentId)))
    return this.runtime.links.sign('download', context.tenantId, attachment.id, new Date())
  }

  @Delete('attachments/:id')
  async remove(@Param('id') attachmentId: string, @Req() request: FilesRequest) {
    const attachment = await this.readable(request, id(attachmentId))
    requireRole(request, attachment.module, 'write')
    return viewOf(
      unwrap(await this.runtime.attachments.remove(commandContext(request), attachment.id)),
    )
  }

  /** Public: the signature, not a token, says which slot the bytes fill. */
  @Put('uploads/:id')
  @PublicRoute()
  @Header('Cache-Control', 'no-store')
  async upload(
    @Param('id') attachmentId: string,
    @Query() query: unknown,
    @Body() body: unknown,
    @Req() request: FilesRequest,
  ) {
    const tenantId = this.verified('upload', id(attachmentId), query)
    if (!Buffer.isBuffer(body))
      throw new UnsupportedMediaTypeException('The body must be the file, with its content type')
    return viewOf(
      unwrap(
        await this.runtime.attachments.receive(tenantId, id(attachmentId), {
          contentType: mediaTypeOf(request.headers['content-type']),
          bytes: body,
        }),
      ),
    )
  }

  /** Public: the signature, not a token, says who may open it; only while available. */
  @Get('attachments/:id/content')
  @PublicRoute()
  async content(
    @Param('id') attachmentId: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: HeaderSink,
  ) {
    const tenantId = this.verified('download', id(attachmentId), query)
    const file = await this.runtime.attachments.content(tenantId, id(attachmentId))
    if (!file) throw new NotFoundException('The attachment is not available')
    const name = file.attachment.fileName
    response.setHeader('Cache-Control', 'private, no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
    response.setHeader(
      'Digest',
      `sha-256=${Buffer.from(file.attachment.sha256 ?? '', 'hex').toString('base64')}`,
    )
    return new StreamableFile(file.bytes, {
      type: file.attachment.contentType,
      disposition: `attachment; filename="${asciiFileName(name)}"; filename*=UTF-8''${encodedFileName(name)}`,
      length: file.bytes.length,
    })
  }

  /** The tenant a valid link names; anything else is refused alike. */
  private verified(kind: 'upload' | 'download', attachmentId: string, query: unknown): string {
    const link = linkQuery.safeParse(query)
    if (
      !link.success ||
      !this.runtime.links.verify(
        kind,
        { tenantId: link.data.tenant, attachmentId, ...link.data },
        new Date(),
      )
    )
      throw new ForbiddenException('The link is not valid, or it has expired')
    return link.data.tenant
  }

  /** An attachment of the caller's tenant whose module role lets them read it. */
  private async readable(request: FilesRequest, attachmentId: string): Promise<Attachment> {
    const attachment = await this.runtime.attachments.find(
      principalOf(request).tenantId,
      attachmentId,
    )
    if (!attachment || attachment.status === 'deleted')
      throw new NotFoundException('Attachment was not found')
    requireRole(request, attachment.module, 'read')
    return attachment
  }
}
