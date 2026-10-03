import { randomUUID } from 'node:crypto'
import {
  type FiscalCatalogPackage,
  type FiscalRuleChange,
  type FiscalRuleDiff,
  type FiscalTaxSupportMatrix,
  fiscalRuleChangeListSchema,
  fiscalRuleChangeRequestSchema,
  fiscalRuleChangeSchema,
  type fiscalWorkspaceRuleListSchema,
} from '@horizon/contracts'
import postgres from 'postgres'
import type { z } from 'zod'
import { appendAudit } from './audit'
import { canonicalDigest } from './canonical-json'
import {
  catalogPackages,
  packageExists,
  packageRules,
  rulesInForce,
  workspaceRules,
} from './catalog-reads'
import { authoritiesFor } from './delegations'
import {
  applyChange,
  type ParsedChangeRequest,
  planChange,
  RuleChangeRefused,
} from './rule-change-plans'
import { diffRules } from './rule-diff'
import { ruleImpact } from './rule-impact'
import type { FiscalRuleStore } from './rule-store'
import { SUPPORT_MATRIX } from './tax-support-api'

export { RuleChangeRefused } from './rule-change-plans'

/** The pair a decision is refused under (ADR 0062). */
export const RULES_PAIR = 'fiscal.rules'

/** Whoever asked deciding it, in person or through a delegation (ADR 0062). */
export class RuleChangeDutiesRefused extends Error {
  readonly pair = RULES_PAIR
}

/**
 * Tax rule changes (Phase 88, ADR 0074): a request, with its diff and its impact, that
 * another person approves; approval applies it in the same transaction.
 */
export class FiscalRuleChanges {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly masterKey: Buffer,
    private readonly store: Pick<FiscalRuleStore, 'ruleSet'>,
    private readonly supportMatrix: FiscalTaxSupportMatrix | 'unchecked' = SUPPORT_MATRIX,
    private readonly now: () => Date = () => new Date(),
    statementTimeout = 60_000,
  ) {
    this.#db = postgres(databaseUrl, {
      max: 5,
      connection: { statement_timeout: statementTimeout },
    })
  }

  get sql(): postgres.Sql {
    return this.#db
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  packages(tenantId: string): Promise<FiscalCatalogPackage[]> {
    return this.#inTenant(tenantId, (tx) => catalogPackages(tx, tenantId))
  }

  workspaceRules(tenantId: string): Promise<z.infer<typeof fiscalWorkspaceRuleListSchema>['data']> {
    return this.#inTenant(tenantId, (tx) => workspaceRules(tx, tenantId))
  }

  /** A package against the rules in force today, or against another package. */
  diffPackage(tenantId: string, packageId: string, against?: string): Promise<FiscalRuleDiff> {
    return this.#inTenant(tenantId, async (tx) => {
      if (!(await packageExists(tx, packageId)))
        throw new RuleChangeRefused(404, 'Catalogue package not found')
      const after = (await packageRules(tx, tenantId, packageId)).summaries
      if (against) {
        if (!(await packageExists(tx, against)))
          throw new RuleChangeRefused(404, 'Catalogue package not found')
        const before = (await packageRules(tx, tenantId, against)).summaries
        return diffRules(before, after, { kind: 'package', packageId: against })
      }
      const keys = new Set(after.map((rule) => rule.ruleKey))
      const before = (await rulesInForce(tx, tenantId)).filter((rule) => keys.has(rule.ruleKey))
      return diffRules(before, after, { kind: 'workspace' })
    })
  }

  /** Records a request with its diff and its impact. A Fiscal admin asks; nothing applies yet. */
  async request(input: {
    tenantId: string
    actorId: string
    body: unknown
  }): Promise<FiscalRuleChange> {
    const parsed = fiscalRuleChangeRequestSchema.safeParse(input.body)
    if (!parsed.success)
      throw new RuleChangeRefused(
        400,
        `Invalid rule change: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${
          parsed.error.issues[0]?.message ?? ''
        }`.trim(),
      )
    const request = parsed.data
    const id = randomUUID()
    const now = this.now()
    await this.#inTenant(input.tenantId, async (tx) => {
      const plan = await planChange(tx, input.tenantId, request)
      // Two pending requests never compete for the same package or rule.
      await tx`select pg_advisory_xact_lock(hashtextextended(
        ${input.tenantId} || ':rule-change:' || ${plan.subjectKey}, 0))`
      const [pending] = await tx`select change.id from fiscal_rule_changes change
        where change.tenant_id = ${input.tenantId} and change.subject_key = ${plan.subjectKey}
          and not exists (select 1 from fiscal_rule_change_decisions decision
            where decision.tenant_id = change.tenant_id and decision.change_id = change.id)
        limit 1`
      if (pending)
        throw new RuleChangeRefused(409, 'A pending request is already about this', {
          pendingChangeId: String(pending.id),
        })
      const impact = await ruleImpact({
        tx,
        masterKey: this.masterKey,
        tenantId: input.tenantId,
        ruleSet: (model, environment) => this.store.ruleSet(input.tenantId, model, environment),
        overlay: plan.overlay,
        supportMatrix: this.supportMatrix,
        months: request.impactMonths,
        now,
      })
      const stored = { ...request } as Record<string, unknown>
      const requestDigest = canonicalDigest(stored)
      await tx`insert into fiscal_rule_changes (
        id, tenant_id, kind, subject_key, request, request_digest, diff, impact, impact_digest,
        requested_by, requested_at
      ) values (
        ${id}, ${input.tenantId}, ${request.kind}, ${plan.subjectKey},
        ${tx.json(stored as postgres.JSONValue)}, ${requestDigest},
        ${tx.json(plan.diff as unknown as postgres.JSONValue)},
        ${tx.json(impact as unknown as postgres.JSONValue)}, ${impact.digest},
        ${input.actorId}, ${now}
      )`
      await appendAudit(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: 'rule-change.requested',
        resourceId: id,
        detail: {
          kind: request.kind,
          subjectKey: plan.subjectKey,
          requestDigest,
          impactDigest: impact.digest,
          counts: plan.diff.counts,
          changedDocuments: impact.changed.length,
          unsupportedDocuments: impact.unsupported.length,
        },
      })
    })
    return this.#require(input.tenantId, id)
  }

  /**
   * Approves or rejects a pending request. The decider holds the approval through their
   * role or an active delegation, and never asked for it, in person or through whom they
   * decide for (ADR 0062). Approval applies the change in the same transaction.
   */
  async decide(input: {
    tenantId: string
    actorId: string
    holdsApproval: boolean
    changeId: string
    outcome: 'approved' | 'rejected'
    reason?: string | undefined
  }): Promise<FiscalRuleChange> {
    const now = this.now()
    await this.#inTenant(input.tenantId, async (tx) => {
      const change = await this.#pending(tx, input.tenantId, input.changeId)
      const authorities = await authoritiesFor(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        holdsApproval: input.holdsApproval,
        now,
      })
      if (authorities.length === 0)
        throw new RuleChangeRefused(
          403,
          'Deciding this needs fiscal:rules:approve through a role or an active delegation',
        )
      const requester = String(change.requested_by)
      const authority = authorities.find(
        (candidate) => candidate.actor !== requester && candidate.onBehalfOf !== requester,
      )
      if (!authority)
        throw new RuleChangeDutiesRefused(
          authorities.some((candidate) => candidate.onBehalfOf === requester)
            ? 'Whoever asked for a rule change cannot decide it, even through a delegation'
            : 'Whoever asked for a rule change cannot decide it',
        )
      const request = fiscalRuleChangeRequestSchema.parse(change.request) as ParsedChangeRequest
      const resultId =
        input.outcome === 'approved'
          ? await applyChange(tx, {
              tenantId: input.tenantId,
              changeId: input.changeId,
              request,
              requestedBy: requester,
              approvedBy: authority.actor,
              now,
            })
          : null
      await tx`insert into fiscal_rule_change_decisions (
        tenant_id, change_id, outcome, decided_by, on_behalf_of, delegation_id, reason,
        result_id, decided_at
      ) values (
        ${input.tenantId}, ${input.changeId}, ${input.outcome}, ${authority.actor},
        ${authority.onBehalfOf}, ${authority.delegationId}, ${input.reason ?? null},
        ${resultId}, ${now}
      )`
      await appendAudit(tx, {
        tenantId: input.tenantId,
        actorId: authority.actor,
        action: `rule-change.${input.outcome}`,
        resourceId: input.changeId,
        detail: {
          kind: request.kind,
          requestedBy: requester,
          requestDigest: change.request_digest,
          impactDigest: change.impact_digest,
          ...(resultId ? { resultId } : {}),
          ...(authority.onBehalfOf
            ? { onBehalfOf: authority.onBehalfOf, delegationId: authority.delegationId }
            : {}),
          ...(input.reason ? { reason: input.reason } : {}),
        },
      })
    })
    return this.#require(input.tenantId, input.changeId)
  }

  /** The requester withdraws a request nobody decided yet. */
  async cancel(input: {
    tenantId: string
    actorId: string
    changeId: string
    reason?: string | undefined
  }): Promise<FiscalRuleChange> {
    const now = this.now()
    await this.#inTenant(input.tenantId, async (tx) => {
      const change = await this.#pending(tx, input.tenantId, input.changeId)
      if (change.requested_by !== input.actorId)
        throw new RuleChangeRefused(403, 'Only the requester cancels a rule change')
      await tx`insert into fiscal_rule_change_decisions (
        tenant_id, change_id, outcome, decided_by, reason, decided_at
      ) values (
        ${input.tenantId}, ${input.changeId}, 'cancelled', ${input.actorId},
        ${input.reason ?? null}, ${now}
      )`
      await appendAudit(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: 'rule-change.cancelled',
        resourceId: input.changeId,
        detail: { kind: change.kind, ...(input.reason ? { reason: input.reason } : {}) },
      })
    })
    return this.#require(input.tenantId, input.changeId)
  }

  get(tenantId: string, changeId: string): Promise<FiscalRuleChange | null> {
    return this.#inTenant(tenantId, async (tx) => {
      const [row] = await tx`${changeQuery(tx)} where change.tenant_id = ${tenantId}
        and change.id = ${changeId}`
      return row ? present(row) : null
    })
  }

  list(tenantId: string): Promise<z.infer<typeof fiscalRuleChangeListSchema>> {
    return this.#inTenant(tenantId, async (tx) => {
      const rows = await tx`${changeQuery(tx)} where change.tenant_id = ${tenantId}
        order by change.sequence desc limit 200`
      return fiscalRuleChangeListSchema.parse({
        data: rows.map((row) => {
          const { diff, impact, ...change } = present(row)
          return {
            ...change,
            counts: diff.counts,
            changedDocuments: impact.changed.length,
            unsupportedDocuments: impact.unsupported.length,
          }
        }),
      })
    })
  }

  async #pending(
    tx: postgres.TransactionSql,
    tenantId: string,
    changeId: string,
  ): Promise<postgres.Row> {
    // One decision at a time per workspace (Phase 91): each checks that its change still
    // applies against the rules in force, and two changes decided at once would each check
    // without the other, and both apply.
    await tx`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':rules:decide', 0))`
    const [change] = await tx`select change.*, decision.outcome from fiscal_rule_changes change
      left join fiscal_rule_change_decisions decision
        on decision.tenant_id = change.tenant_id and decision.change_id = change.id
      where change.tenant_id = ${tenantId} and change.id = ${changeId}`
    if (!change) throw new RuleChangeRefused(404, 'Rule change not found')
    if (change.outcome) throw new RuleChangeRefused(409, `This rule change was ${change.outcome}`)
    return change
  }

  async #require(tenantId: string, changeId: string): Promise<FiscalRuleChange> {
    const found = await this.get(tenantId, changeId)
    if (!found) throw new Error('Fiscal rule change was not stored')
    return found
  }

  #inTenant<T>(tenantId: string, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return work(tx)
    }) as Promise<T>
  }
}

function changeQuery(tx: postgres.TransactionSql) {
  return tx`select change.*, decision.outcome, decision.decided_by, decision.on_behalf_of,
      decision.delegation_id, decision.decided_at, decision.reason as decision_reason,
      decision.result_id
    from fiscal_rule_changes change
    left join fiscal_rule_change_decisions decision
      on decision.tenant_id = change.tenant_id and decision.change_id = change.id`
}

function present(row: postgres.Row): FiscalRuleChange {
  const instant = (value: unknown) => new Date(value as string).toISOString()
  return fiscalRuleChangeSchema.parse({
    id: String(row.id),
    kind: row.kind,
    status: row.outcome ?? 'pending',
    request: row.request,
    requestDigest: row.request_digest,
    requestedBy: row.requested_by,
    requestedAt: instant(row.requested_at),
    diff: row.diff,
    impact: row.impact,
    decision: row.outcome
      ? {
          outcome: row.outcome,
          decidedBy: row.decided_by,
          onBehalfOf: row.on_behalf_of ?? null,
          delegationId: row.delegation_id ? String(row.delegation_id) : null,
          decidedAt: instant(row.decided_at),
          reason: row.decision_reason ?? null,
          resultId: row.result_id ? String(row.result_id) : null,
        }
      : null,
  })
}
