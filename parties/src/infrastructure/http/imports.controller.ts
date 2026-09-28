import { importMappingSchema, importUploadSchema } from '@horizon/contracts'
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  GoneException,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common'
import { z } from 'zod'
import type { ImportFailure, ImportView } from '@/application/imports/imports'
import type { Either } from '@/core/either'
import { PartiesRuntime } from '@/main/parties-runtime'
import { type PartiesRequest, RequirePartiesAction, tenantOf } from './authorization'

const kindParam = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)
const jobKey = z.string().trim().min(1).max(200)
const listQuery = z.strictObject({ kind: kindParam.optional() })

interface DownloadResponse {
  setHeader(name: string, value: string): void
  send(body: Buffer): void
}

function unwrap<T>(result: Either<ImportFailure, T>): T {
  if (result.isRight()) return result.value
  const { kind, message } = result.value
  if (kind === 'not-found') throw new NotFoundException(message)
  if (kind === 'conflict') throw new ConflictException(message)
  if (kind === 'gone') throw new GoneException(message)
  throw new BadRequestException(message)
}

function id(value: string): string {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new BadRequestException('Invalid import id')
  return parsed.data
}

/** The job as the published contract shapes it (`@horizon/contracts`, ADR 0059). */
export function presentImport({ job, progress }: ImportView) {
  return {
    id: job.id,
    kind: job.kind,
    jobKey: job.jobKey,
    status: job.status,
    fileName: job.fileName,
    format: job.format,
    locale: job.locale,
    sha256: job.sha256,
    columns: job.columns,
    mapping: job.mapping,
    progress,
    requestedBy: job.requestedBy,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    failuresUntil: job.failuresUntil?.toISOString() ?? null,
  }
}

function bytesOf(format: 'csv' | 'xlsx', content: string): Uint8Array {
  if (format === 'csv') return new TextEncoder().encode(content)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content))
    throw new BadRequestException('An XLSX file travels as base64')
  return Buffer.from(content, 'base64')
}

/** Bulk imports into this module, through its own use cases (ADR 0059). */
@Controller('imports')
export class ImportsController {
  constructor(@Inject(PartiesRuntime) private readonly runtime: PartiesRuntime) {}

  @Get('kinds')
  @RequirePartiesAction('import')
  kinds() {
    return { data: this.runtime.imports.kinds() }
  }

  @Get()
  @RequirePartiesAction('import')
  async list(@Query() query: unknown, @Req() request: PartiesRequest) {
    const parsed = listQuery.safeParse(query)
    if (!parsed.success) throw new BadRequestException('Invalid import filter')
    const views = await this.runtime.imports.list(tenantOf(request), parsed.data.kind)
    return { data: views.map(presentImport) }
  }

  @Post(':kind')
  @RequirePartiesAction('import')
  async upload(
    @Param('kind') kind: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Req() request: PartiesRequest,
    @Res({ passthrough: true }) response: { status(code: number): void },
  ) {
    const parsedKind = kindParam.safeParse(kind)
    if (!parsedKind.success) throw new NotFoundException('this module has no such import')
    const parsedKey = jobKey.safeParse(key)
    if (!parsedKey.success)
      throw new BadRequestException('An Idempotency-Key header names the import job')
    const upload = importUploadSchema.safeParse(body)
    if (!upload.success)
      throw new BadRequestException(upload.error.issues[0]?.message ?? 'Invalid upload')
    const outcome = unwrap(
      await this.runtime.imports.upload({
        tenantId: tenantOf(request),
        actor: request.principal?.subject ?? '',
        kind: parsedKind.data,
        jobKey: parsedKey.data,
        fileName: upload.data.fileName,
        format: upload.data.format,
        locale: upload.data.locale,
        bytes: bytesOf(upload.data.format, upload.data.content),
      }),
    )
    response.status(outcome.created ? 201 : 200)
    return presentImport(outcome.view)
  }

  @Get(':id')
  @RequirePartiesAction('import')
  async get(@Param('id') jobId: string, @Req() request: PartiesRequest) {
    return presentImport(unwrap(await this.runtime.imports.get(tenantOf(request), id(jobId))))
  }

  @Put(':id/mapping')
  @RequirePartiesAction('import')
  async map(@Param('id') jobId: string, @Body() body: unknown, @Req() request: PartiesRequest) {
    const parsed = importMappingSchema.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid mapping')
    return presentImport(
      unwrap(await this.runtime.imports.map(tenantOf(request), id(jobId), parsed.data.mapping)),
    )
  }

  @Post(':id/preview')
  @RequirePartiesAction('import')
  @HttpCode(200)
  async preview(@Param('id') jobId: string, @Req() request: PartiesRequest) {
    const preview = unwrap(await this.runtime.imports.preview(tenantOf(request), id(jobId)))
    return { job: presentImport(preview.view), errors: preview.errors, sample: preview.sample }
  }

  @Post(':id/confirm')
  @RequirePartiesAction('import')
  @HttpCode(202)
  async confirm(@Param('id') jobId: string, @Req() request: PartiesRequest) {
    return presentImport(unwrap(await this.runtime.imports.confirm(tenantOf(request), id(jobId))))
  }

  @Post(':id/cancel')
  @RequirePartiesAction('import')
  @HttpCode(200)
  async cancel(@Param('id') jobId: string, @Req() request: PartiesRequest) {
    return presentImport(unwrap(await this.runtime.imports.cancel(tenantOf(request), id(jobId))))
  }

  @Get(':id/failures')
  @RequirePartiesAction('import')
  async failures(
    @Param('id') jobId: string,
    @Req() request: PartiesRequest,
    @Res() response: DownloadResponse,
  ) {
    const file = unwrap(await this.runtime.imports.failures(tenantOf(request), id(jobId)))
    response.setHeader('Content-Type', file.contentType)
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    )
    response.setHeader('Cache-Control', 'no-store')
    response.send(Buffer.from(file.bytes))
  }
}
