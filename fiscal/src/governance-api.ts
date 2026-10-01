import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  fiscalRuleChangeDecisionRequestSchema,
  SEGREGATION_OF_DUTIES_CODE,
  SEGREGATION_OF_DUTIES_TYPE,
} from '@horizon/contracts'
import type { FiscalPermission, FiscalPrincipal } from './auth'
import { may } from './auth'
import { DelegationRefused, type FiscalDelegations } from './delegations'
import { type FiscalRuleChanges, RuleChangeDutiesRefused, RuleChangeRefused } from './rule-changes'

export type GovernanceDependencies = {
  changes: Pick<
    FiscalRuleChanges,
    'packages' | 'workspaceRules' | 'diffPackage' | 'request' | 'decide' | 'cancel' | 'get' | 'list'
  >
  delegations: Pick<FiscalDelegations, 'list' | 'grant' | 'revoke'>
}

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
const PACKAGE_DIFF = new RegExp(`^/catalog/packages/${UUID}/diff$`)
const CHANGE = new RegExp(`^/rule-changes/${UUID}$`)
const CHANGE_DECISION = new RegExp(`^/rule-changes/${UUID}/(approve|reject|cancel)$`)
const DELEGATION_REVOKE = new RegExp(`^/delegations/${UUID}/revoke$`)

/**
 * Governing the tax rules (Phase 88, ADR 0074): the catalogue, the workspace's rows, the
 * requests and their decisions, and the delegation of the approval (ADR 0062). The caller
 * already holds a role that reads.
 */
export async function handleGovernanceRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  principal: FiscalPrincipal,
  dependencies: GovernanceDependencies,
): Promise<boolean> {
  const { changes, delegations } = dependencies
  const tenantId = principal.tenantId
  const holdsApproval = may(principal, 'rules:approve')
  try {
    if (request.method === 'GET' && url.pathname === '/catalog/packages') {
      json(response, 200, { data: await changes.packages(tenantId) })
      return true
    }
    const diff = PACKAGE_DIFF.exec(url.pathname)
    if (request.method === 'GET' && diff?.[1]) {
      const against = url.searchParams.get('against') ?? undefined
      if (against && !new RegExp(`^${UUID}$`).test(against)) {
        problem(response, 400, 'Bad Request', 'against must be a package id')
        return true
      }
      json(response, 200, await changes.diffPackage(tenantId, diff[1], against))
      return true
    }
    if (request.method === 'GET' && url.pathname === '/rules') {
      json(response, 200, { data: await changes.workspaceRules(tenantId) })
      return true
    }
    if (url.pathname === '/rule-changes') {
      if (request.method === 'GET') {
        json(response, 200, await changes.list(tenantId))
        return true
      }
      if (request.method === 'POST') {
        if (!allowed(principal, 'rules:manage', response)) return true
        const body = await readJson(request)
        json(response, 201, await changes.request({ tenantId, actorId: principal.subject, body }))
        return true
      }
    }
    const change = CHANGE.exec(url.pathname)
    if (request.method === 'GET' && change?.[1]) {
      const found = await changes.get(tenantId, change[1])
      if (found) json(response, 200, found)
      else problem(response, 404, 'Not Found', 'Rule change not found')
      return true
    }
    const decision = CHANGE_DECISION.exec(url.pathname)
    if (request.method === 'POST' && decision?.[1] && decision[2]) {
      const body = fiscalRuleChangeDecisionRequestSchema.safeParse(await readJson(request))
      if (!body.success) {
        problem(response, 400, 'Bad Request', 'Invalid decision')
        return true
      }
      const changeId = decision[1]
      if (decision[2] === 'cancel') {
        if (!allowed(principal, 'rules:manage', response)) return true
        json(
          response,
          200,
          await changes.cancel({
            tenantId,
            actorId: principal.subject,
            changeId,
            reason: body.data.reason,
          }),
        )
        return true
      }
      // A delegate holds the approval through a delegation, not their role: the service
      // checks either (ADR 0062).
      json(
        response,
        200,
        await changes.decide({
          tenantId,
          actorId: principal.subject,
          holdsApproval,
          changeId,
          outcome: decision[2] === 'approve' ? 'approved' : 'rejected',
          reason: body.data.reason,
        }),
      )
      return true
    }
    if (url.pathname === '/delegations') {
      if (request.method === 'GET') {
        json(response, 200, { data: await delegations.list(tenantId) })
        return true
      }
      if (request.method === 'POST') {
        json(
          response,
          201,
          await delegations.grant({
            tenantId,
            actorId: principal.subject,
            holdsApproval,
            body: await readJson(request),
          }),
        )
        return true
      }
    }
    const revoke = DELEGATION_REVOKE.exec(url.pathname)
    if (request.method === 'POST' && revoke?.[1]) {
      json(
        response,
        200,
        await delegations.revoke({
          tenantId,
          actorId: principal.subject,
          holdsApproval,
          delegationId: revoke[1],
        }),
      )
      return true
    }
  } catch (error) {
    if (error instanceof RuleChangeDutiesRefused) {
      dutiesProblem(response, error.message, error.pair)
      return true
    }
    if (error instanceof RuleChangeRefused || error instanceof DelegationRefused) {
      problemWith(response, error.status, error.message, 'extra' in error ? error.extra : {})
      return true
    }
    if (error instanceof SyntaxError) {
      problem(response, 400, 'Bad Request', 'Invalid JSON body')
      return true
    }
    throw error
  }
  return false
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
}

function allowed(
  principal: FiscalPrincipal,
  permission: FiscalPermission,
  response: ServerResponse,
): boolean {
  if (may(principal, permission)) return true
  problem(response, 403, 'Forbidden', 'Fiscal role does not permit this operation')
  return false
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 256 * 1024) throw new SyntaxError('Fiscal request body is too large')
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.setHeader('cache-control', 'private, no-store')
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function problem(response: ServerResponse, status: number, title: string, detail: string): void {
  problemWith(response, status, detail, {}, title)
}

function problemWith(
  response: ServerResponse,
  status: number,
  detail: string,
  extra: Record<string, unknown>,
  title = TITLES[status] ?? 'Error',
): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/problem+json; charset=utf-8' })
  response.end(JSON.stringify({ type: 'about:blank', title, status, detail, ...extra }))
}

/** The one refusal every module gives for a pair of duties (ADR 0062). */
function dutiesProblem(response: ServerResponse, detail: string, pair: string): void {
  if (response.headersSent) return
  response.writeHead(403, { 'content-type': 'application/problem+json; charset=utf-8' })
  response.end(
    JSON.stringify({
      type: SEGREGATION_OF_DUTIES_TYPE,
      title: 'Segregation of duties',
      status: 403,
      code: SEGREGATION_OF_DUTIES_CODE,
      pair,
      detail,
    }),
  )
}
