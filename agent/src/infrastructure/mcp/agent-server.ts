import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { AgentCalls, AgentSession } from '@/application/agent-calls'

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

/** A draft writes, destroys nothing, and is written once however often it is retried. */
const draftAnnotations = { ...readAnnotations, readOnlyHint: false } as const

/**
 * One MCP server per request (stateless). It lists only the tools this key's scopes reach,
 * and every `tools/call` — a tool out of reach or malformed included — goes through the call
 * use case, so the audit sees each attempt, not only the ones that succeed (ADR 0065).
 */
export function createAgentServer(calls: AgentCalls, session: AgentSession): Server {
  const server = new Server(
    { name: 'horizon-agent', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Horizon ERP. Every tool acts through your API key, with exactly what the person who ' +
        'issued it may do. Writes are drafts that a person must still approve or post. Lists ' +
        'are capped; a cut answer says truncated: true.',
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: calls.tools(session).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(z.strictObject(tool.input)) as {
        type: 'object'
        [key: string]: unknown
      },
      annotations: tool.kind === 'draft' ? draftAnnotations : readAnnotations,
    })),
  }))
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const answer = await calls.call(
        session,
        request.params.name,
        request.params.arguments ?? {},
        extra.requestId,
      )
      return {
        content: [{ type: 'text', text: answer.text }],
        ...(answer.isError ? { isError: true } : {}),
      }
    },
  )
  return server
}
