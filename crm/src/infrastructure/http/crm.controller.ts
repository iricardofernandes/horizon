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
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import { ACCOUNT_ROLES, LAWFUL_BASES } from '@/domain/value-objects/crm-values'
import { CrmRuntime } from '@/main/crm-runtime'
import { type CrmRequest, PublicRoute, permits, RequireCrmAction, tenantOf } from './authorization'
import { context, idempotent, pageOf } from './command-context'
import { id, parse, unwrap } from './request-parsing'

const optionalText = (max: number) => z.string().max(max).nullish()

const contactInput = z.strictObject({
  name: z.string().min(1).max(160),
  jobTitle: optionalText(120),
  email: optionalText(254),
  phone: optionalText(24),
  lawfulBasis: z.enum(LAWFUL_BASES),
})

const profileInput = z
  .strictObject({
    ownerId: z.uuid().nullable().optional(),
    segment: optionalText(80),
    tags: z.array(z.string().max(40)).max(20).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'send at least one of ownerId, segment, tags')

const accountQuery = z.object({
  search: z.string().trim().max(160).optional(),
  role: z.enum(ACCOUNT_ROLES).optional(),
  ownerId: z.uuid().optional(),
  status: z.enum(['active', 'inactive', 'erased']).optional(),
})

const statusInput = z.strictObject({ active: z.boolean() })

@Controller()
export class CrmController {
  constructor(@Inject(CrmRuntime) private readonly runtime: CrmRuntime) {}

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

  @Get('accounts')
  @RequireCrmAction('read')
  async accounts(@Query() query: unknown, @Req() request: CrmRequest) {
    const filter = parse(accountQuery, query)
    const page = pageOf(query)
    const result = await this.runtime.database.listAccounts(tenantOf(request), {
      search: filter.search || null,
      role: filter.role ?? null,
      ownerId: filter.ownerId ?? null,
      status: filter.status ?? null,
      ...page,
    })
    return { data: result.data, page: { ...page, total: result.total } }
  }

  @Get('accounts/:id')
  @RequireCrmAction('read')
  @Header('Cache-Control', 'no-store')
  async account(@Param('id') accountId: string, @Req() request: CrmRequest) {
    const detail = await this.runtime.database.accountDetail(tenantOf(request), id(accountId))
    if (!detail) throw new NotFoundException('Account was not found')
    return { ...detail.account, contacts: detail.contacts }
  }

  /** Reassigning the owner is a manager's decision; segment and tags are anyone's work. */
  @Patch('accounts/:id')
  @RequireCrmAction('write')
  async describeAccount(
    @Param('id') accountId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    const profile = parse(profileInput, body)
    if (profile.ownerId !== undefined && !permits(request.principal?.roles ?? [], 'assign'))
      throw new ForbiddenException('The CRM role does not permit reassigning owners')
    return unwrap(
      await this.runtime.updateAccountProfile.execute({
        context: context(request),
        accountId: id(accountId),
        profile,
      }),
    )
  }

  @Post('accounts/:id/contacts')
  @RequireCrmAction('write')
  async createContact(
    @Param('id') accountId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    return unwrap(
      await this.runtime.createContact.execute({
        context: idempotent(request),
        accountId: id(accountId),
        contact: parse(contactInput, body),
      }),
    )
  }

  @Get('contacts/:id')
  @RequireCrmAction('read')
  @Header('Cache-Control', 'no-store')
  async contact(@Param('id') contactId: string, @Req() request: CrmRequest) {
    const contact = await this.runtime.database.contactDetail(tenantOf(request), id(contactId))
    if (!contact) throw new NotFoundException('Contact was not found')
    return contact
  }

  @Put('contacts/:id')
  @RequireCrmAction('write')
  async reviseContact(
    @Param('id') contactId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    return unwrap(
      await this.runtime.reviseContact.execute({
        context: context(request),
        contactId: id(contactId),
        contact: parse(contactInput, body),
      }),
    )
  }

  @Patch('contacts/:id/status')
  @RequireCrmAction('write')
  @HttpCode(204)
  async changeContactStatus(
    @Param('id') contactId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    unwrap(
      await this.runtime.changeContactStatus.execute({
        context: context(request),
        contactId: id(contactId),
        active: parse(statusInput, body).active,
      }),
    )
  }

  /** Crypto-shredding: the row remains for the account's history; the person's data does not. */
  @Delete('contacts/:id')
  @RequireCrmAction('erase')
  @HttpCode(204)
  async eraseContact(@Param('id') contactId: string, @Req() request: CrmRequest) {
    unwrap(
      await this.runtime.eraseContact.execute({
        context: context(request),
        contactId: id(contactId),
      }),
    )
  }

  @Get('owners')
  @RequireCrmAction('read')
  async owners(@Req() request: CrmRequest) {
    return { data: await this.runtime.database.listOwners(tenantOf(request)) }
  }
}
