/**
 * The web side of the tenant's MCP server (ADR 0065): where an agent connects, and the
 * agent's calls as the audit log records them. The agent service decides everything.
 */

export type AgentSettings = { enabled: boolean; updatedBy: string | null; updatedAt: string | null }

export type AgentCall = {
  sequence: number
  occurredAt: string
  keyId: string
  tool: string
  outcome: string
  status: number | null
  rows: number | null
  truncated: boolean
}

type AuditEntry = {
  sequence: number
  occurredAt: string
  actor: string
  subjectId: string
  details: Record<string, unknown>
}

/** The MCP endpoint as an agent reaches it: the gateway, never the web server. */
export function agentEndpoint(apiUrl: string, tenantId: string): string {
  return `${apiUrl.replace(/\/$/, '')}/agent/tenants/${tenantId}/mcp`
}

/** One audit entry of a call, as a row of the call log. */
export function callOf(entry: AuditEntry): AgentCall {
  const { outcome, status, rows, truncated } = entry.details
  return {
    sequence: entry.sequence,
    occurredAt: entry.occurredAt,
    keyId: entry.actor.replace(/^api-key:/, ''),
    tool: entry.subjectId,
    outcome: typeof outcome === 'string' ? outcome : 'unknown',
    status: typeof status === 'number' ? status : null,
    rows: typeof rows === 'number' ? rows : null,
    truncated: truncated === true,
  }
}
