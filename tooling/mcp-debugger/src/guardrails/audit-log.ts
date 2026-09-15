import { appendFile } from 'node:fs/promises'

export type AuditEntry = {
  timestamp: string
  caller: string
  tool: string
  arguments: unknown
  outcome: 'success' | 'error' | 'rate_limited'
  resultBytes: number
  durationMs: number
  error?: string
}

export interface AuditSink {
  write(entry: AuditEntry): Promise<void>
}

export class JsonFileAuditSink implements AuditSink {
  constructor(private readonly path: string) {}

  async write(entry: AuditEntry): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
}
