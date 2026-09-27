import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
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
import { TAXPAYER_INDICATORS } from '@/domain/value-objects/fiscal-profile'
import { PARTY_KINDS, PARTY_ROLES } from '@/domain/value-objects/party-values'
import { PartiesRuntime } from '@/main/parties-runtime'
import { type PartiesRequest, PublicRoute, RequirePartiesAction, tenantOf } from './authorization'

// Contact fields are optional here; which roles require them is a domain rule (ADR 0057).
const details = {
  legalName: z.string().trim().min(2).max(160),
  tradeName: z.string().trim().max(160).nullish(),
  email: z.email().max(254).nullish(),
  phone: z.string().min(8).max(24).nullish(),
  address: z.string().min(5).max(500).nullish(),
}
const documentInput = z.discriminatedUnion('type', [
  z.strictObject({ type: z.enum(['cpf', 'cnpj']), number: z.string().min(11).max(18) }),
  z.strictObject({
    type: z.literal('foreign'),
    country: z.string().length(2),
    number: z.string().min(1).max(40),
  }),
  z.strictObject({ type: z.literal('none') }),
])
const registerInput = z.strictObject({
  partyId: z.uuid().optional(),
  kind: z.enum(PARTY_KINDS),
  // `taxId` is the pre-Phase 54 shorthand for a CPF or a CNPJ; send it or `document`.
  taxId: z.string().min(11).max(18).optional(),
  document: documentInput.optional(),
  roles: z.array(z.enum(PARTY_ROLES)).max(PARTY_ROLES.length).default([]),
  ...details,
})
const describeInput = z.strictObject(details)
const identifyInput = z.strictObject({ document: documentInput })
const lookalikeInput = z.strictObject({
  legalName: details.legalName,
  email: z.string().trim().max(254).nullish(),
  phone: z.string().trim().max(24).nullish(),
  document: documentInput.optional(),
})
const roleInput = z.strictObject({ operation: z.enum(['grant', 'revoke']) })
const statusInput = z.strictObject({ active: z.boolean() })
const fiscalProfileInput = z.strictObject({
  effectiveFrom: z.iso.date(),
  stateRegistration: z.string().trim().min(1).max(40).nullable(),
  municipalRegistration: z.string().trim().min(1).max(40).nullable(),
  taxpayerIndicator: z.enum(TAXPAYER_INDICATORS),
  finalConsumer: z.boolean(),
  address: z.strictObject({
    street: z.string().trim().min(1).max(160),
    number: z.string().trim().min(1).max(160),
    complement: z.string().trim().max(160).nullable(),
    district: z.string().trim().min(1).max(160),
    city: z.string().trim().min(1).max(160),
    municipalityCode: z.string().trim().nullable(),
    state: z.string().trim().nullable(),
    postalCode: z.string().trim(),
    country: z.string().trim().length(2),
  }),
})
const listQuery = z.strictObject({
  role: z.enum(PARTY_ROLES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
const fiscalListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.uuid().optional(),
})

/** The document leaves as its type and last characters only; the full value is not a list field. */
function present(party: PartySnapshot) {
  const suffix =
    party.status === 'erased' || party.document.number === null
      ? null
      : party.document.number.slice(-4)
  return {
    id: party.id,
    kind: party.kind,
    legalName: party.legalName,
    tradeName: party.tradeName,
    document: { type: party.document.type, country: party.document.country, suffix },
    taxIdSuffix: suffix,
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

  @Get('parties/fiscal-profiles')
  @RequirePartiesAction('fiscal-read')
  @Header('Cache-Control', 'no-store')
  async listFiscalProfiles(@Query() query: unknown, @Req() request: PartiesRequest) {
    const parsed = fiscalListQuery.safeParse(query)
    if (!parsed.success) throw new BadRequestException('Invalid fiscal profile cursor')
    return this.runtime.database.listFiscalProfileRevisions(
      tenantOf(request),
      parsed.data.limit,
      parsed.data.cursor,
    )
  }

  /** A read, sent as a POST because the probe carries personal data that must not sit in a URL. */
  @Post('parties/duplicate-check')
  @RequirePartiesAction('read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async duplicateCheck(@Body() body: unknown, @Req() request: PartiesRequest) {
    const parsed = lookalikeInput.safeParse(body)
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid duplicate check')
    const matches = unwrap(
      await this.runtime.findLookalikes.execute({ ...parsed.data, tenantId: tenantOf(request) }),
    )
    // Enough to recognise the party, not a second copy of its record.
    return {
      data: matches.map(({ party, matchedOn }) => {
        const snapshot = party.toSnapshot()
        return {
          partyId: snapshot.id,
          legalName: snapshot.legalName,
          tradeName: snapshot.tradeName,
          roles: snapshot.roles,
          status: snapshot.status,
          matchedOn,
        }
      }),
    }
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

  /** Once, for a party registered without a document (ADR 0057). */
  @Put('parties/:id/document')
  @RequirePartiesAction('manage')
  @HttpCode(204)
  async identify(@Param('id') id: string, @Body() body: unknown, @Req() request: PartiesRequest) {
    const parsed = identifyInput.safeParse(body)
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid document')
    unwrap(
      await this.runtime.identifyParty.execute({
        tenantId: tenantOf(request),
        partyId: uuid(id),
        document: parsed.data.document,
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

  @Put('parties/:id/fiscal-profile')
  @RequirePartiesAction('manage')
  async describeFiscalProfile(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: PartiesRequest,
  ) {
    const parsed = fiscalProfileInput.safeParse(body)
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid fiscal profile')
    const revision = unwrap(
      await this.runtime.describeFiscalProfile.execute({
        tenantId: tenantOf(request),
        partyId: uuid(id),
        profile: parsed.data,
      }),
    )
    return { revision }
  }

  @Get('parties/:id/fiscal-profile/:revision')
  @RequirePartiesAction('fiscal-read')
  @Header('Cache-Control', 'no-store')
  async fiscalProfile(
    @Param('id') id: string,
    @Param('revision') revision: string,
    @Req() request: PartiesRequest,
  ) {
    const parsed = z.coerce.number().int().positive().safeParse(revision)
    if (!parsed.success) throw new BadRequestException('Invalid fiscal profile revision')
    const profile = await this.runtime.database.findFiscalExport(
      tenantOf(request),
      uuid(id),
      parsed.data,
    )
    if (!profile) throw new NotFoundException('Fiscal profile was not found')
    return profile
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
