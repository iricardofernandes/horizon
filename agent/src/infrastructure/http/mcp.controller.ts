import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { All, Controller, Inject, Logger, Param, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import type { Refusal } from '@/application/agent-calls'
import { createAgentServer } from '@/infrastructure/mcp/agent-server'
import { AgentRuntime } from '@/main/agent-runtime'
import { PublicRoute } from './authorization'

const tenantIdSchema = z.uuid()
/** An API key in its published shape (ADR 0022); anything else is not worth an exchange. */
const KEY = /^Bearer (hz_(?:live|test|dev)_[A-Za-z0-9]{24}_[A-Za-z0-9]{32})$/

function refuse(response: Response, refusal: Refusal): void {
  if (refusal.status === 401) response.setHeader('WWW-Authenticate', 'Bearer')
  if (refusal.retryAfterSeconds)
    response.setHeader('Retry-After', String(refusal.retryAfterSeconds))
  response
    .status(refusal.status)
    .type('application/problem+json')
    .send({
      type: `https://horizon.dev/problems/${refusal.code}`,
      title: 'Agent request refused',
      status: refusal.status,
      detail: refusal.detail,
    })
}

/**
 * The tenant's MCP endpoint (ADR 0065): stateless streamable HTTP, JSON answers, one server
 * per request. The API key is authenticated here, by exchanging it, not by the guard.
 */
@Controller('tenants/:tenantId/mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name)

  constructor(@Inject(AgentRuntime) private readonly runtime: AgentRuntime) {}

  @Post()
  @PublicRoute()
  async handle(
    @Param('tenantId') tenantId: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const key = KEY.exec(request.headers.authorization ?? '')?.[1]
    if (!tenantIdSchema.safeParse(tenantId).success || !key)
      return refuse(response, {
        status: 401,
        code: 'key-refused',
        detail: 'An API key is required as a Bearer token',
      })

    const admission = await this.runtime.calls.admit(tenantId, key)
    if (!admission.ok) return refuse(response, admission.refusal)

    const server = createAgentServer(this.runtime.calls, admission.session)
    // No session id generator: stateless, as the debugger's transport (ADR 0065).
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    response.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      // SDK 1.30's declaration omits exact-optional compatibility while the runtime
      // implements the Transport contract; the cast stays at this one adapter edge.
      await server.connect(transport as Parameters<typeof server.connect>[0])
      await transport.handleRequest(request, response, request.body)
    } catch (error) {
      this.logger.error({ event: 'agent.mcp-failed', error: (error as Error).name })
      if (!response.headersSent)
        response
          .status(500)
          .json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    }
  }

  /** Stateless: there is no stream to open and no session to end. */
  @All()
  @PublicRoute()
  others(@Res() response: Response): void {
    response
      .status(405)
      .setHeader('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
  }
}
