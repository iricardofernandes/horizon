import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import type { Either } from '@/core/either'
import type { UseCaseError } from '@/core/errors/use-case-error'
import type { PartySnapshot } from '@/domain/entities/party'
import { PARTY_KINDS, PARTY_ROLES } from '@/domain/value-objects/party-values'
import { PartiesRuntime } from '@/main/parties-runtime'
import { type PartiesRequest, PublicRoute, RequirePartiesAction, tenantOf } from './authorization'

const details = {
  legalName: z.string().trim().min(2).max(160),
  tradeName: z.string().trim().max(160).nullish(),
  email: z.email().max(254),
  phone: z.string().min(8).max(24),
  address: z.string().min(5).max(500),
}
const registerInput = z.strictObject({
  partyId: z.uuid().optional(),
  kind: z.enum(PARTY_KINDS),
  taxId: z.string().min(11).max(18),
  roles: z.array(z.enum(PARTY_ROLES)).max(PARTY_ROLES.length).default([]),
  ...details,
})
const describeInput = z.strictObject(details)
const roleInput = z.strictObject({ operation: z.enum(['grant', 'revoke']) })
const statusInput = z.strictObject({ active: z.boolean() })
const listQuery = z.strictObject({
  role: z.enum(PARTY_ROLES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

/** The tax identifier leaves as its last digits only; the full value is not a list field. */
function present(party: PartySnapshot) {
  return {
    id: party.id,
    kind: party.kind,
    legalName: party.legalName,
    tradeName: party.tradeName,
    taxIdSuffix: party.status === 'erased' ? null : party.taxId.slice(-4),
    email: party.email,
    phone: party.phone,
    address: party.address,
    roles: party.roles,
    status: party.status,
    createdAt: party.createdAt,
    updatedAt: party.updatedAt,
  }
}

function unwrap<T>(result: Either<UseCaseError, T>): T {
  if (result.isRight()) return result.value
  if (result.value.title === 'Conflict') throw new ConflictException(result.value.message)
  if (result.value.title === 'Resource not found') throw new NotFoundException(result.value.message)
  throw new BadRequestException(result.value.message)
}

function uuid(value: string): string {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new BadRequestException('Invalid party id')
  return parsed.data
}

@Controller()
export class PartiesController {
  constructor(@Inject(PartiesRuntime) private readonly runtime: PartiesRuntime) {}

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

  @Get('parties')
  @RequirePartiesAction('read')
  async list(@Query() query: unknown, @Req() request: PartiesRequest) {
    const parsed = listQuery.safeParse(query)
    if (!parsed.success) throw new BadRequestException('Invalid party filter')
    const rows = await this.runtime.database.listSnapshots(tenantOf(request), {
      limit: parsed.data.limit,
      ...(parsed.data.role === undefined ? {} : { role: parsed.data.role }),
    })
    return { data: rows.map(present) }
  }

  @Get('parties/:id')
  @RequirePartiesAction('read')
  async get(@Param('id') id: string, @Req() request: PartiesRequest) {
    const party = await this.runtime.database.findSnapshot(tenantOf(request), uuid(id))
    if (!party) throw new NotFoundException('Party was not found')
    return present(party)
  }

  @Post('parties')
  @RequirePartiesAction('manage')
  async register(@Body() body: unknown, @Req() request: PartiesRequest) {
    const parsed = registerInput.safeParse(body)
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid party')
    return unwrap(
      await this.runtime.registerParty.execute({ ...parsed.data, tenantId: tenantOf(request) }),
    )
  }

  @Put('parties/:id')
  @RequirePartiesAction('manage')
  @HttpCode(204)
  async describe(@Param('id') id: string, @Body() body: unknown, @Req() request: PartiesRequest) {
    const parsed = describeInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid party')
    unwrap(
      await this.runtime.describeParty.execute({
        ...parsed.data,
        tenantId: tenantOf(request),
        partyId: uuid(id),
      }),
    )
  }

  @Put('parties/:id/roles/:role')
  @RequirePartiesAction('manage')
  @HttpCode(204)
  async changeRole(
    @Param('id') id: string,
    @Param('role') role: string,
    @Body() body: unknown,
    @Req() request: PartiesRequest,
  ) {
    const parsed = roleInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid role change')
    unwrap(
      await this.runtime.changeRole.execute({
        tenantId: tenantOf(request),
        partyId: uuid(id),
        role,
        operation: parsed.data.operation,
      }),
    )
  }

  @Patch('parties/:id/status')
  @RequirePartiesAction('manage')
  @HttpCode(204)
  async changeStatus(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: PartiesRequest,
  ) {
    const parsed = statusInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid status change')
    unwrap(
      await this.runtime.changeStatus.execute({
        tenantId: tenantOf(request),
        partyId: uuid(id),
        active: parsed.data.active,
      }),
    )
  }

  /** Crypto-shredding: the row remains for document integrity; its personal data does not. */
  @Delete('parties/:id')
  @RequirePartiesAction('erase')
  @HttpCode(204)
  async erase(@Param('id') id: string, @Req() request: PartiesRequest) {
    unwrap(
      await this.runtime.eraseParty.execute({ tenantId: tenantOf(request), partyId: uuid(id) }),
    )
  }
}
