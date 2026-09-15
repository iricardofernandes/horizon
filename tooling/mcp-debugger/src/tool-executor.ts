import type { AuditSink } from './guardrails/audit-log.js'
import { RateLimiter } from './guardrails/rate-limiter.js'
import { limitResult } from './guardrails/result-limiter.js'
import type { Redactor } from './redaction/redactor.js'

export class ToolExecutor {
  private readonly rateLimiter: RateLimiter

  constructor(
    limit: number,
    private readonly maxRows: number,
    private readonly maxBytes: number,
    private readonly redactor: Redactor,
    private readonly audit: AuditSink,
  ) {
    this.rateLimiter = new RateLimiter(limit)
  }

  async run(caller: string, tool: string, args: unknown, operation: () => Promise<unknown>) {
    const started = Date.now()
    const safeArgs = this.redactor.apply(args)
    try {
      this.rateLimiter.assertAllowed(caller, tool)
    } catch (error) {
      const safeError = String(this.redactor.apply(messageOf(error)))
      await this.audit.write({
        timestamp: new Date().toISOString(),
        caller,
        tool,
        arguments: safeArgs,
        outcome: 'rate_limited',
        resultBytes: 0,
        durationMs: Date.now() - started,
        error: safeError,
      })
      throw new Error(safeError)
    }

    try {
      const result = this.redactor.apply(await operation())
      const limited = limitResult(result, this.maxRows, this.maxBytes)
      const response = { ...limited, safeguards: { piiMasked: true, tenantIdsHashed: true } }
      await this.audit.write({
        timestamp: new Date().toISOString(),
        caller,
        tool,
        arguments: safeArgs,
        outcome: 'success',
        resultBytes: Buffer.byteLength(JSON.stringify(response)),
        durationMs: Date.now() - started,
      })
      return response
    } catch (error) {
      const safeError = String(this.redactor.apply(messageOf(error)))
      await this.audit.write({
        timestamp: new Date().toISOString(),
        caller,
        tool,
        arguments: safeArgs,
        outcome: 'error',
        resultBytes: 0,
        durationMs: Date.now() - started,
        error: safeError,
      })
      throw new Error(safeError)
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
