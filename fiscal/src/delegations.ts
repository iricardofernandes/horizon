import { randomUUID } from 'node:crypto'
import {
  DELEGATION_MAX_DAYS,
  type Delegation,
  delegablePermissions,
  grantDelegationSchema,
} from '@horizon/contracts'
import type postgres from 'postgres'
import { appendAudit } from './audit'

const DAY_MS = 86_400_000

/** The approval Fiscal lends (ADR 0062): deciding a tax rule change. */
export const RULES_APPROVE = 'fiscal:rules:approve'

/**
 * Who decides, and for whom. `onBehalfOf` is the approver who lent the approval when the
 * person deciding holds it only through a delegation; both names are recorded.
 */
export type ApprovalAuthority = {
  actor: string
  onBehalfOf: string | null
  delegationId: string | null
}

export class DelegationRefused extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Lending Fiscal's approval for a period (ADR 0062, Phase 88). The delegate needs a role in
 * Fiscal, which their own token proves each time; the delegation lends the approval alone,
 * and cannot be passed on.
 */
export class FiscalDelegations {
  constructor(
    private readonly db: postgres.Sql,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(tenantId: string): Promise<Delegation[]> {
    const rows = await this.db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select * from fiscal_approval_delegations where tenant_id = ${tenantId}
        order by created_at desc limit 200`
    })
    return rows.map((row) => present(row, this.now()))
  }

  /** Only someone holding the approval through their role lends it. */
  async grant(input: {
    tenantId: string
    actorId: string
    holdsApproval: boolean
    body: unknown
  }): Promise<Delegation> {
    const grant = grantDelegationSchema.safeParse(input.body)
    if (!grant.success) throw new DelegationRefused(400, 'Invalid delegation')
    if (!delegablePermissions('fiscal').includes(grant.data.permission))
      throw new DelegationRefused(400, 'Fiscal lends only fiscal:rules:approve')
    if (!input.holdsApproval)
      throw new DelegationRefused(403, 'Only someone holding this approval through a role lends it')
    const startsAt = new Date(grant.data.startsAt)
    const endsAt = new Date(grant.data.endsAt)
    const now = this.now()
    if (grant.data.delegateId === input.actorId)
      throw new DelegationRefused(400, 'A delegation is lent to someone else')
    if (endsAt <= startsAt) throw new DelegationRefused(400, 'A delegation ends after it starts')
    if (endsAt <= now) throw new DelegationRefused(400, 'A delegation ends in the future')
    if (endsAt.getTime() - startsAt.getTime() > DELEGATION_MAX_DAYS * DAY_MS)
      throw new DelegationRefused(400, `A delegation lasts at most ${DELEGATION_MAX_DAYS} days`)
    const id = randomUUID()
    const [row] = await this.db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${input.tenantId}, true)`
      const inserted = await tx`insert into fiscal_approval_delegations (
        id, tenant_id, permission, delegator_id, delegate_id, starts_at, ends_at, reason
      ) values (
        ${id}, ${input.tenantId}, ${grant.data.permission}, ${input.actorId},
        ${grant.data.delegateId}, ${startsAt}, ${endsAt}, ${grant.data.reason ?? null}
      ) returning *`
      await appendAudit(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: 'delegation.granted',
        resourceId: id,
        detail: {
          permission: grant.data.permission,
          delegateId: grant.data.delegateId,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          ...(grant.data.reason ? { reason: grant.data.reason } : {}),
        },
      })
      return inserted
    })
    if (!row) throw new Error('Fiscal delegation was not stored')
    return present(row, now)
  }

  /** The delegator, or anyone holding the approval through a role, ends it early. */
  async revoke(input: {
    tenantId: string
    actorId: string
    holdsApproval: boolean
    delegationId: string
  }): Promise<Delegation> {
    const now = this.now()
    const [row] = await this.db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${input.tenantId}, true)`
      const [found] = await tx`select * from fiscal_approval_delegations
        where tenant_id = ${input.tenantId} and id = ${input.delegationId} for update`
      if (!found) throw new DelegationRefused(404, 'Delegation not found')
      if (found.delegator_id !== input.actorId && !input.holdsApproval)
        throw new DelegationRefused(403, 'Only the delegator or an approver revokes this')
      const state = stateOf(found, now)
      if (state === 'revoked' || state === 'ended')
        throw new DelegationRefused(409, `This delegation has already ${state}`)
      const updated = await tx`update fiscal_approval_delegations
        set revoked_at = ${now}, revoked_by = ${input.actorId}
        where tenant_id = ${input.tenantId} and id = ${input.delegationId} returning *`
      await appendAudit(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: 'delegation.revoked',
        resourceId: input.delegationId,
        detail: { delegatorId: found.delegator_id, delegateId: found.delegate_id },
      })
      return updated
    })
    if (!row) throw new Error('Fiscal delegation was not revoked')
    return present(row, now)
  }
}

/**
 * Who may decide, and for whom: the person's own role when it grants the approval, otherwise
 * every active delegation lent to them, oldest first. None is an empty list.
 */
export async function authoritiesFor(
  tx: postgres.TransactionSql,
  input: { tenantId: string; actorId: string; holdsApproval: boolean; now: Date },
): Promise<ApprovalAuthority[]> {
  if (input.holdsApproval) return [{ actor: input.actorId, onBehalfOf: null, delegationId: null }]
  const rows = await tx`select id, delegator_id from fiscal_approval_delegations
    where tenant_id = ${input.tenantId} and delegate_id = ${input.actorId}
      and permission = ${RULES_APPROVE} and revoked_at is null
      and starts_at <= ${input.now} and ends_at > ${input.now}
    order by created_at`
  return rows.map((row) => ({
    actor: input.actorId,
    onBehalfOf: String(row.delegator_id),
    delegationId: String(row.id),
  }))
}

function stateOf(row: postgres.Row, now: Date): Delegation['status'] {
  if (row.revoked_at) return 'revoked'
  if (now >= new Date(row.ends_at)) return 'ended'
  if (now < new Date(row.starts_at)) return 'scheduled'
  return 'active'
}

function present(row: postgres.Row, now: Date): Delegation {
  const instant = (value: unknown) => new Date(value as string).toISOString()
  return {
    id: String(row.id),
    permission: String(row.permission),
    delegatorId: String(row.delegator_id),
    delegateId: String(row.delegate_id),
    startsAt: instant(row.starts_at),
    endsAt: instant(row.ends_at),
    reason: row.reason === null ? null : String(row.reason),
    status: stateOf(row, now),
    createdAt: instant(row.created_at),
    revokedAt: row.revoked_at ? instant(row.revoked_at) : null,
    revokedBy: row.revoked_by === null ? null : String(row.revoked_by),
  }
}
