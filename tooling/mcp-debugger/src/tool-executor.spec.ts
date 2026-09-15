import { describe, expect, it } from 'vitest'
import type { AuditEntry, AuditSink } from './guardrails/audit-log.js'
import { Redactor } from './redaction/redactor.js'
import { ToolExecutor } from './tool-executor.js'

class MemoryAudit implements AuditSink {
  readonly entries: AuditEntry[] = []
  async write(entry: AuditEntry): Promise<void> {
    this.entries.push(entry)
  }
}

describe('ToolExecutor', () => {
  it('redacts, caps rows and records every successful invocation', async () => {
    const audit = new MemoryAudit()
    const executor = new ToolExecutor(
      10,
      1,
      10_000,
      new Redactor('0123456789abcdef', new Set(['email'])),
      audit,
    )
    const result = await executor.run(
      'caller',
      'search_logs',
      { email: 'secret@test' },
      async () => [{ tenantId: 'tenant-1', email: 'secret@test' }, { tenantId: 'tenant-2' }],
    )
    expect(result).toMatchObject({ truncated: true, returnedRows: 1 })
    expect(JSON.stringify(result)).not.toContain('secret@test')
    expect(audit.entries).toHaveLength(1)
    expect(audit.entries[0]).toMatchObject({
      caller: 'caller',
      tool: 'search_logs',
      outcome: 'success',
    })
    expect(JSON.stringify(audit.entries[0]?.arguments)).not.toContain('secret@test')
  })

  it('rate-limits each caller/tool pair and audits the rejection', async () => {
    const audit = new MemoryAudit()
    const executor = new ToolExecutor(
      1,
      10,
      10_000,
      new Redactor('0123456789abcdef', new Set()),
      audit,
    )
    await executor.run('caller', 'get_trace', {}, async () => ({}))
    await expect(executor.run('caller', 'get_trace', {}, async () => ({}))).rejects.toThrow(
      /rate limit/i,
    )
    expect(audit.entries.at(-1)?.outcome).toBe('rate_limited')
  })
})
