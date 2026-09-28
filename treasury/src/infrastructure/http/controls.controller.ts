import { auditQuerySchema, grantDelegationSchema } from '@horizon/contracts'
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common'
import type { CommandContext } from '@/application/use-cases/commands'
import type { ApprovalDelegation } from '@/domain/controls/approval-delegation'
import { TreasuryRuntime } from '@/main/treasury-runtime'
import {
  actorOf,
  approvalsOf,
  RequireTreasuryAction,
  type TreasuryRequest,
  tenantOf,
} from './authorization'
import { id, parse, unwrap } from './request-parsing'

function context(request: TreasuryRequest): CommandContext {
  const requestId = request.headers['x-request-id']
  return {
    tenantId: tenantOf(request),
    actor: actorOf(request),
    requestId: typeof requestId === 'string' ? requestId.slice(0, 128) : null,
    approvals: approvalsOf(request),
  }
}

export function presentDelegation(delegation: ApprovalDelegation, now: Date) {
  const snapshot = delegation.toSnapshot()
  return {
    id: snapshot.id,
    permission: snapshot.permission,
    delegatorId: snapshot.delegatorId,
    delegateId: snapshot.delegateId,
    startsAt: snapshot.startsAt.toISOString(),
    endsAt: snapshot.endsAt.toISOString(),
    reason: snapshot.reason,
    status: delegation.stateAt(now),
    createdAt: snapshot.createdAt.toISOString(),
    revokedAt: snapshot.revokedAt?.toISOString() ?? null,
    revokedBy: snapshot.revokedBy,
  }
}

/** Lending an approval for a period (ADR 0062). */
@Controller('delegations')
export class DelegationsController {
  constructor(@Inject(TreasuryRuntime) private readonly runtime: TreasuryRuntime) {}

  @Get()
  @RequireTreasuryAction('read')
  async list(@Req() request: TreasuryRequest) {
    const now = new Date()
    const delegations = await this.runtime.listDelegations.execute(context(request))
    return { data: delegations.map((delegation) => presentDelegation(delegation, now)) }
  }

  @Post()
  @RequireTreasuryAction('approve')
  async grant(@Body() body: unknown, @Req() request: TreasuryRequest) {
    const delegation = unwrap(
      await this.runtime.grantDelegation.execute({
        context: context(request),
        grant: parse(grantDelegationSchema, body),
      }),
    )
    return presentDelegation(delegation, new Date())
  }

  @Post(':id/revoke')
  @RequireTreasuryAction('read')
  @HttpCode(200)
  async revoke(@Param('id') delegationId: string, @Req() request: TreasuryRequest) {
    const delegation = unwrap(
      await this.runtime.revokeDelegation.execute({
        context: context(request),
        delegationId: id(delegationId),
      }),
    )
    return presentDelegation(delegation, new Date())
  }
}

/** The tenant's audit log, a page at a time, with the chain's verdict (Phase 68). */
@Controller('audit')
export class AuditController {
  constructor(@Inject(TreasuryRuntime) private readonly runtime: TreasuryRuntime) {}

  @Get()
  @RequireTreasuryAction('audit')
  async page(@Query() query: unknown, @Req() request: TreasuryRequest) {
    const filter = parse(auditQuerySchema, query)
    return this.runtime.database.auditPage(tenantOf(request), {
      actor: filter.actor,
      action: filter.action,
      subjectType: filter.subjectType,
      subjectId: filter.subjectId,
      from: filter.from ? new Date(filter.from) : undefined,
      to: filter.to ? new Date(filter.to) : undefined,
      before: filter.cursor ? Number(filter.cursor) : undefined,
      limit: filter.limit,
    })
  }
}
