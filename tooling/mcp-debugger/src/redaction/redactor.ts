import { createHmac } from 'node:crypto'

const tenantFields = new Set(['tenantid', 'tenant_id', 'tenant'])

export class Redactor {
  constructor(
    private readonly tenantSalt: string,
    private readonly piiFields: ReadonlySet<string>,
  ) {}

  apply(value: unknown): unknown {
    return this.visit(value, '')
  }

  private visit(value: unknown, key: string): unknown {
    const normalized = key.toLowerCase()
    if (tenantFields.has(normalized) && typeof value === 'string') return this.hashTenant(value)
    if (this.piiFields.has(normalized) && value !== null && value !== undefined) return '[REDACTED]'
    if (Array.isArray(value)) return value.map((entry) => this.visit(entry, key))
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          this.visit(entryValue, entryKey),
        ]),
      )
    }
    if (typeof value === 'string') return this.maskPatterns(value)
    return value
  }

  private hashTenant(value: string): string {
    return `tenant_${createHmac('sha256', this.tenantSalt).update(value).digest('hex').slice(0, 16)}`
  }

  private maskPatterns(value: string): string {
    return value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
      .replace(/\b\d{3}[.-]?\d{3}[.-]?\d{3}-?\d{2}\b/g, '[REDACTED_CPF]')
      .replace(/\b\d{2}[.]?\d{3}[.]?\d{3}[/]?\d{4}-?\d{2}\b/g, '[REDACTED_CNPJ]')
  }
}
