import { z } from 'zod'
import { argumentsDigest, type CallOutcome, capResult, outcomeOf } from '@/domain/results'
import { requestFor, type ToolEntry, toolsFor } from './catalogue'
import type { AgentStore, CallMetrics, Clock, Gateway, KeyExchange } from './ports'

/** The one scope every agent key needs, besides the modules it reads (ADR 0065). */
export const CONNECT_SCOPE = 'agent:connect'

/** What the token minted for the key says about it, verified against Identity's keys. */
export interface KeyClaims {
  readonly tenantId: string
  readonly scopes: readonly string[]
  readonly keyIssuer: string | null
}

export abstract class KeyTokens {
  abstract read(accessToken: string): Promise<KeyClaims>
}

/** A request the agent may serve: the key, its token and what it reaches. */
export interface AgentSession {
  readonly tenantId: string
  readonly apiKeyId: string
  readonly issuer: string | null
  readonly accessToken: string
  readonly scopes: readonly string[]
}

export interface Refusal {
  readonly status: number
  readonly code: string
  readonly detail: string
  readonly retryAfterSeconds?: number
}

export type Admission = { ok: true; session: AgentSession } | { ok: false; refusal: Refusal }

export interface ToolAnswer {
  readonly text: string
  readonly isError: boolean
  readonly outcome: CallOutcome
}

export interface CallLimits {
  readonly maxRows: number
  readonly maxBytes: number
}

const refuse = (status: number, code: string, detail: string, retryAfterSeconds?: number) =>
  ({
    ok: false,
    refusal: { status, code, detail, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
  }) as const

/** The module's own words about a refusal, bounded: never a stack or an internal name. */
function detailOf(body: unknown): string {
  if (body === null || typeof body !== 'object') return ''
  const { detail, title, message } = body as Record<string, unknown>
  const text = [detail, message, title].find((value) => typeof value === 'string')
  return typeof text === 'string' ? text.slice(0, 200) : ''
}

/**
 * Everything an agent's request does, in order (ADR 0065): access on, the key exchanged,
 * `agent:connect` held; then each tool call is a `GET` through the gateway with that key's
 * own token, cut to the caps and audited before the answer leaves.
 */
export class AgentCalls {
  constructor(
    private readonly store: AgentStore,
    private readonly keys: KeyExchange,
    private readonly tokens: KeyTokens,
    private readonly gateway: Gateway,
    private readonly clock: Clock,
    private readonly metrics: CallMetrics,
    private readonly limits: CallLimits,
  ) {}

  async admit(tenantId: string, presented: string): Promise<Admission> {
    // Before any exchange: a workspace that has not let agents in spends nothing on them.
    if (!(await this.store.accessEnabled(tenantId)))
      return refuse(403, 'agent-access-off', 'Agent access is off for this workspace')

    const started = performance.now()
    const exchanged = await this.keys.exchange(tenantId, presented)
    this.metrics.exchanged((performance.now() - started) / 1000)
    if (!exchanged.ok) {
      const { status, detail, retryAfterSeconds } = exchanged.refusal
      return refuse(status, 'key-refused', detail, retryAfterSeconds)
    }

    let claims: KeyClaims
    try {
      claims = await this.tokens.read(exchanged.key.accessToken)
    } catch {
      return refuse(401, 'key-refused', 'The key token could not be verified')
    }
    if (claims.tenantId !== tenantId)
      return refuse(401, 'key-refused', 'The key does not belong to this workspace')
    if (!claims.scopes.includes(CONNECT_SCOPE))
      return refuse(403, 'agent-connect-missing', `The key needs the ${CONNECT_SCOPE} scope`)

    return {
      ok: true,
      session: {
        tenantId,
        apiKeyId: exchanged.key.apiKeyId,
        issuer: claims.keyIssuer,
        accessToken: exchanged.key.accessToken,
        scopes: claims.scopes,
      },
    }
  }

  tools(session: AgentSession): readonly ToolEntry[] {
    return toolsFor(session.scopes)
  }

  async call(
    session: AgentSession,
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ToolAnswer> {
    const tool = this.tools(session).find((entry) => entry.name === name)
    if (!tool)
      return this.finish(session, name, args, {
        text: `No tool named ${name} is available to this key`,
        isError: true,
        outcome: 'refused',
        status: 403,
        rows: null,
        bytes: 0,
        truncated: false,
      })

    // Validated here, not by the protocol layer, so a malformed call is audited too.
    const parsed = z.strictObject(tool.input).safeParse(args)
    if (!parsed.success)
      return this.finish(session, name, args, {
        text: `Invalid arguments: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
          .join('; ')
          .slice(0, 300)}`,
        isError: true,
        outcome: 'refused',
        status: 400,
        rows: null,
        bytes: 0,
        truncated: false,
      })

    let answer: { status: number; body: unknown }
    try {
      const { path, query } = requestFor(tool, parsed.data, this.limits.maxRows)
      answer = await this.gateway.read(path, query, session.accessToken)
    } catch {
      return this.finish(session, name, args, {
        text: 'Horizon could not be reached; try again later',
        isError: true,
        outcome: 'failed',
        status: 0,
        rows: null,
        bytes: 0,
        truncated: false,
      })
    }

    const outcome = outcomeOf(answer.status)
    if (outcome !== 'ok') {
      const detail = outcome === 'failed' ? 'the module failed' : detailOf(answer.body)
      return this.finish(session, name, args, {
        text: `Horizon answered ${answer.status}${detail ? `: ${detail}` : ''}`,
        isError: true,
        outcome,
        status: answer.status,
        rows: null,
        bytes: 0,
        truncated: false,
      })
    }
    const capped = capResult(answer.body, this.limits.maxRows, this.limits.maxBytes)
    return this.finish(session, name, args, {
      text: capped.text,
      isError: false,
      outcome,
      status: answer.status,
      rows: capped.rows,
      bytes: capped.bytes,
      truncated: capped.truncated,
    })
  }

  /**
   * The call is audited before its answer leaves: if it cannot be recorded, the agent gets
   * an error and no data (ADR 0065). The audit keeps a digest of the arguments, never them.
   */
  private async finish(
    session: AgentSession,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    result: ToolAnswer & {
      status: number
      rows: number | null
      bytes: number
      truncated: boolean
    },
  ): Promise<ToolAnswer> {
    try {
      await this.store.audit(session.tenantId, {
        actor: `api-key:${session.apiKeyId}`,
        subjectType: 'agent-tool',
        subjectId: tool,
        action: 'agent.tool.called',
        occurredAt: this.clock.now(),
        details: {
          issuer: session.issuer,
          argumentsDigest: argumentsDigest({ ...args }),
          outcome: result.outcome,
          status: result.status,
          resultBytes: result.bytes,
          rows: result.rows,
          truncated: result.truncated,
        },
      })
    } catch {
      this.metrics.called({ tool, outcome: 'failed' })
      return {
        text: 'The call could not be recorded, so nothing was returned',
        isError: true,
        outcome: 'failed',
      }
    }
    this.metrics.called({ tool, outcome: result.outcome })
    return { text: result.text, isError: result.isError, outcome: result.outcome }
  }
}
